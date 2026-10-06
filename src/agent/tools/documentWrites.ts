/**
 * The three document writes, as tools: update_document, edit_document,
 * replace_selection.
 *
 * These are the bodies of the old single-shot completion path (useChatLLM's
 * onDone), moved behind the tool interface unchanged in what they do to the
 * document. Every guard they carried is still here and still documented where
 * it lives: the accepted-reading base, the truncation/elision check, the image
 * safety net, the selection relocation.
 *
 * What the move adds is composition (§5.3 of the spec): writes match against
 * the run's working copy and the store receives `base → working`, so a second
 * write in the same run lands on top of the first instead of diffing against
 * a document the first already changed.
 */
import { defineTool } from '../registry'
import type { ToolContext, ToolResult } from '../types'
import { DOCUMENT_TOOLS, type DocumentToolName } from '../../utils/documentTools'
import { partialStringArgument } from '../../utils/toolCallStream'
import {
  applyEditBlocks,
  applyEditBlocksLocally,
  stripBlankParagraphs,
  stripIncompleteEndTag,
  trimIncompleteHtmlTail,
  validateCanvasReplacement,
  type EditBlock
} from '../../utils/text'
import { diffHtml, stripDiffMarkup } from '../../utils/diff'
import { reinsertMissingImages } from '../../utils/imagePreservation'

const schemaOf = (name: DocumentToolName) => {
  const tool = DOCUMENT_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`No schema for ${name}`)
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

/**
 * The run's working copy of the active document, created on first use.
 *
 * The base is the ACCEPTED reading of the document as the turn found it: the
 * model was shown the document with pending review markup stripped, so its
 * SEARCH text is clean — and a clean needle never matches a haystack full of
 * <ins>/<del> wrappers (user-reported: deleting a paragraph the previous turn
 * had rewritten did nothing). Diffing from the accepted reading also keeps a
 * rewrite from nesting a diff inside the pending one.
 */
function workingCopy(ctx: ToolContext) {
  if (!ctx.run.working) {
    const base = stripDiffMarkup(ctx.document.original)
    ctx.run.working = { base, html: base, dirty: false }
  }
  return ctx.run.working
}

/** Commit the run's state of the document, or put the turn's original back. */
function commitWorking(ctx: ToolContext): void {
  const working = workingCopy(ctx)
  ctx.document.commit(working.dirty ? diffHtml(working.base, working.html) : ctx.document.original)
}

const htmlArg = (raw: Record<string, unknown> | null) =>
  raw && typeof raw.html === 'string' ? raw.html : ''

// ── update_document ─────────────────────────────────────────────────────────

export const updateDocumentTool = defineTool<{ html: string; argumentsLost: boolean }>({
  ...schemaOf('update_document'),
  kind: 'write',
  isAvailable: () => true,
  // Unparseable arguments mean the call was cut off mid-document. That is a
  // truncated rewrite, not an unusable request, and it is reported as one.
  parse: raw => ({ html: htmlArg(raw), argumentsLost: raw === null }),
  preview: (text, ctx) => {
    // The live preview: the partial `html` argument is readable long before
    // the JSON closes (205 deltas measured on a real stream, every one of
    // them renderable).
    const partial = partialStringArgument(text, 'html')
    if (partial !== null) ctx.editor.previewDocument(trimIncompleteHtmlTail(partial))
  },
  execute: ({ html, argumentsLost }, ctx, call): ToolResult => {
    const closed = !argumentsLost && call.unclosed !== true
    if (closed && !html.trim()) {
      return { ok: false, content: 'update_document had an empty html argument; nothing was written.', trace: 'update_document: empty', effects: { producedNothing: true } }
    }

    // Guard the destructive full-document replacement: a response that was
    // cut off, or that abbreviates unchanged regions with placeholders, would
    // silently delete content. Keep what the run has and say so.
    const candidate = stripBlankParagraphs(ctx.images.restore(html))
    const issue = validateCanvasReplacement(candidate, closed)
    if (issue) {
      commitWorking(ctx)
      return {
        ok: false,
        content: issue === 'truncated'
          ? 'The rewrite was cut off before it finished, so it was not applied.'
          : 'The rewrite abbreviated unchanged parts of the document, so applying it would have deleted content. It was not applied.',
        trace: `update_document: ${issue}`,
        effects: { canvasIssue: issue }
      }
    }

    // Image safety net: an image whose placeholder token the model dropped is
    // re-inserted near its original position instead of vanishing.
    const { html: rewritten, reinserted } = reinsertMissingImages(candidate, ctx.document.original)
    const working = workingCopy(ctx)
    working.html = rewritten
    working.dirty = true
    commitWorking(ctx)
    return {
      ok: true,
      content: 'The document was rewritten.',
      trace: 'update_document',
      effects: { reinsertedImages: reinserted }
    }
  }
})

// ── edit_document ───────────────────────────────────────────────────────────

export const editDocumentTool = defineTool<{ edits: EditBlock[] }>({
  ...schemaOf('edit_document'),
  kind: 'write',
  isAvailable: () => true,
  parse: raw => {
    if (!raw) return 'its arguments could not be parsed'
    const list = Array.isArray(raw.edits) ? raw.edits : []
    const edits = list
      .filter((e): e is { search: string; replace?: unknown } =>
        !!e && typeof e === 'object' && typeof (e as { search?: unknown }).search === 'string')
      .map(e => ({ search: e.search, replace: typeof e.replace === 'string' ? e.replace : '' }))
    return edits.length > 0 ? { edits } : 'it contained no usable edit (each needs a "search" string)'
  },
  execute: ({ edits }, ctx): ToolResult => {
    const report = (failed: EditBlock[], where: string): ToolResult => {
      if (failed.length > 0) {
        // Surface the unmatched SEARCH text for diagnosis — the usual cause
        // is the model paraphrasing instead of copying verbatim.
        console.warn(
          `[edit-apply] ${failed.length}/${edits.length} edit block(s)${where} failed to match.`,
          failed.map(f => ({ search: f.search }))
        )
      }
      const applied = edits.length - failed.length
      return {
        ok: failed.length === 0,
        content: failed.length === 0
          ? `Applied ${applied} edit(s).`
          : `Applied ${applied} of ${edits.length} edit(s). These SEARCH texts were not found in the document:\n` +
            failed.map(f => `- ${f.search}`).join('\n'),
        trace: `edit_document: ${applied}/${edits.length}`,
        effects: { failedEdits: failed.length }
      }
    }

    // Edits that come with a selection rewrite target text OUTSIDE the
    // selection. They land on the rewritten document as local diffs, so the
    // selection's own diff stays pending for review. Without a placed
    // selection there is no trustworthy document to apply them to (the
    // chapter may have been switched) — they are reported instead.
    if (ctx.run.selectionAttempted) {
      const editor = ctx.editor.current()
      if (!ctx.run.selectionApplied || !editor) return report(edits, ' beside the selection')
      const local = applyEditBlocksLocally(ctx.images.preserve(editor.getHTML()), edits)
      if (local.failed.length < edits.length) ctx.document.commit(ctx.images.restore(local.html))
      return report(local.failed, ' beside the selection')
    }

    // Edits whose SEARCH text can't be located are skipped (never
    // destructive) and reported.
    const working = workingCopy(ctx)
    const { html, failed } = applyEditBlocks(ctx.images.preserve(working.html), edits)
    if (failed.length < edits.length) {
      working.html = stripBlankParagraphs(ctx.images.restore(html))
      working.dirty = true
    }
    commitWorking(ctx)
    return report(failed, '')
  }
})

// ── replace_selection ───────────────────────────────────────────────────────

export const replaceSelectionTool = defineTool<{ html: string }>({
  ...schemaOf('replace_selection'),
  kind: 'write',
  // Offered only when the turn has a selection to replace.
  isAvailable: ctx => ctx.selection.range() !== null,
  // Never refused at parse time: the attempt itself decides what edits beside
  // it may do (see edit_document), so it must always reach execute.
  parse: raw => ({ html: htmlArg(raw) }),
  preview: (text, ctx) => {
    const partial = partialStringArgument(text, 'html')
    if (partial !== null) ctx.editor.previewSelection(trimIncompleteHtmlTail(partial))
  },
  execute: ({ html }, ctx): ToolResult => {
    ctx.run.selectionAttempted = true
    const cleaned = stripIncompleteEndTag(html)
    if (!cleaned.trim()) {
      return { ok: false, content: 'replace_selection had an empty html argument; nothing was written.', trace: 'replace_selection: empty', effects: { producedNothing: true } }
    }

    const editor = ctx.editor.current()
    if (editor) ctx.selection.relocate()
    const range = ctx.selection.range()
    if (!editor || !range) {
      return { ok: false, content: 'The selection could not be found in the editor.', trace: 'replace_selection: no selection' }
    }

    const restored = stripBlankParagraphs(ctx.images.restore(cleaned))
    const diffed = diffHtml(ctx.selection.originalText(), restored)
    if (ctx.editor.replaceRange(range.from, ctx.selection.end() ?? range.to, diffed) === null) {
      // The selection is gone (chapter switched, document shortened). Say so
      // rather than throwing the turn away: the text is in the chat for the
      // user to place themselves.
      return {
        ok: false,
        content: 'The selected text is no longer where it was, so nothing was written.',
        trace: 'replace_selection: selection gone',
        effects: { selectionGone: true }
      }
    }
    ctx.document.commit(editor.getHTML())
    ctx.run.selectionApplied = true
    return { ok: true, content: 'The selection was rewritten.', trace: 'replace_selection' }
  }
})

export const DOCUMENT_WRITE_TOOLS = [updateDocumentTool, editDocumentTool, replaceSelectionTool]
