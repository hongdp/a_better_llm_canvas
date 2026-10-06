/**
 * The three document writes, as tools: update_document, edit_document,
 * replace_selection.
 *
 * These are the bodies of the old single-shot completion path (useChatLLM's
 * onDone), moved behind the tool interface. Every guard they carried is still
 * here and still documented where it lives: the accepted-reading base, the
 * truncation/elision check, the image safety net, the selection relocation.
 *
 * What the loop adds:
 *  - composition (§5.3): writes match against a per-chapter working copy and
 *    the store receives `base → working`, so a second write in the same run
 *    lands on top of the first;
 *  - a target (D2): `chapter` names any chapter. Absent = the chapter the
 *    turn started on, which is all the protocol could reach before. The
 *    start chapter stays synchronous; another chapter may need its content
 *    loaded first, so writes to it are async;
 *  - the seen-content rule (D2): an edit is refused on a chapter whose HTML
 *    the model has not seen this run;
 *  - the user-edit rule: the user may edit other chapters while the run
 *    works, and a write whose chapter they changed meanwhile is refused
 *    rather than written over their edit (`userEdited`).
 */
import { defineTool } from '../registry'
import { citeChapter, resolveChapter, type ResolvedChapter } from '../chapters'
import type { DocState, ToolContext, ToolResult } from '../types'
import type { AgentTouchedChapter } from '../../types/chat'
import { DOCUMENT_TOOLS, type DocumentToolName } from '../../utils/documentTools'
import { partialStringArgument } from '../../utils/toolCallStream'
import {
  applyEditBlocks,
  applyEditBlocksLocally,
  stripBlankParagraphs,
  stripIncompleteEndTag,
  trimIncompleteHtmlTail,
  validateCanvasReplacement,
  isBlankContent,
  type EditBlock
} from '../../utils/text'
import { diffHtml, stripDiffMarkup } from '../../utils/diff'
import { resolveDiffMarkupInHtml } from '../../utils/diffResolution'
import { reinsertMissingImages } from '../../utils/imagePreservation'
import { htmlToPlainText } from '../../utils/llmContext'

const schemaOf = (name: DocumentToolName) => {
  const tool = DOCUMENT_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`No schema for ${name}`)
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

// ── Targets ─────────────────────────────────────────────────────────────────

export interface Target extends ResolvedChapter {
  isStart: boolean
}

/** Which chapter a write goes to. Absent = the chapter the turn started on. */
export function resolveTarget(ref: unknown, ctx: ToolContext): Target | string {
  const chapters = ctx.document.chapters()
  if (ref === undefined || ref === null || ref === '') {
    const index = chapters.findIndex(c => c.id === ctx.document.startId)
    if (index === -1) return 'The chapter this turn started on no longer exists.'
    return { id: chapters[index].id, title: chapters[index].title, number: index + 1, isStart: true }
  }
  const resolved = resolveChapter(ref, chapters)
  if (typeof resolved === 'string') return resolved
  return { ...resolved, isStart: resolved.id === ctx.document.startId }
}

/**
 * The run's working copy of a chapter, created on first use.
 *
 * Two readings of a chapter that still carries an unresolved review diff:
 *  - The working copy starts from the ACCEPTED reading. The model is shown
 *    chapters with pending markup stripped, so its SEARCH text is clean — and
 *    a clean needle never matches a haystack full of <ins>/<del> wrappers
 *    (user-reported: deleting a paragraph the previous turn had rewritten did
 *    nothing).
 *  - The review diff is drawn from the REJECTED reading — the last text the
 *    user confirmed.
 *    Problem: it used to be drawn from the accepted reading, so asking for
 *      another change while the previous one was still under review silently
 *      accepted the previous one (user-reported 2026-10-06).
 *    Fix: everything not yet confirmed stays pending, as one diff from the
 *      last confirmed text. Accept-all gives the new text; reject-all gives
 *      back exactly what "reject all" would have before this turn.
 * Both are whole-document diffs, so neither nests a diff inside another.
 */
export function docState(ctx: ToolContext, target: Target): DocState {
  let st = ctx.run.docs.get(target.id)
  if (!st) {
    // A selection preview writes the start chapter through real transactions,
    // so with a selection its stored content is not the turn's original.
    const original = target.isStart && selectionTurn(ctx)
      ? ctx.document.original
      : storedContent(ctx, target.id)
    const base = stripDiffMarkup(original)
    const reviewBase = base === original ? base : resolveDiffMarkupInHtml(original, 'reject')
    st = { original, base, reviewBase, html: base, dirty: false }
    ctx.run.docs.set(target.id, st)
    ctx.run.known.set(target.id, original)
  }
  return st
}

const storedContent = (ctx: ToolContext, id: string) =>
  ctx.document.chapters().find(c => c.id === id)?.content ?? ''

/** The turn rewrites a selection: its chapter is locked for the whole run. */
const selectionTurn = (ctx: ToolContext) => !!ctx.selection.originalText()

/**
 * Has the user changed this chapter since the run last saw or wrote it?
 *
 * The user may edit any chapter the run is not painting while it works
 * (agentic_chat_loop.md §0.4). A write built on the run's copy of a chapter
 * they changed meanwhile would overwrite their edit — so it is refused, and
 * the model reads the chapter again. The start chapter of a selection turn
 * is never edited by the user (it is locked) but is written by the
 * selection preview, so it is not checked.
 */
export function userEdited(ctx: ToolContext, id: string): boolean {
  if (id === ctx.document.startId && selectionTurn(ctx)) return false
  const known = ctx.run.known.get(id)
  return known !== undefined && storedContent(ctx, id) !== known
}

/** Forget the run's copy of a chapter: the next write starts from what is stored now. */
export function forgetChapter(ctx: ToolContext, id: string): void {
  ctx.run.docs.delete(id)
  ctx.run.htmlShown.delete(id)
  ctx.run.known.delete(id)
}

/** The refusal for a write whose chapter the user changed meanwhile. */
export function editedMeanwhile(ctx: ToolContext, target: Target): ToolResult {
  forgetChapter(ctx, target.id)
  return {
    ok: false,
    retryable: true,
    content: `The user edited ${citeChapter(target)} while you were working, so your copy of it is out of date and this change was NOT applied. ` +
      `Read it again (read_chapter with chapters=[${target.number}] and format="html") and make the change on its current text, keeping the user's edits.`,
    trace: `⚠️ ${citeChapter(target)} was edited by the user meanwhile — not written`
  }
}

/**
 * Commit the run's state of a chapter, or put the run's original back.
 *
 * A chapter the turn did not start on gets a version snapshot before its
 * first change (the start chapter's is taken before the send), unless the run
 * created it — there is nothing to go back to.
 */
export function commitDoc(ctx: ToolContext, target: Target, st: DocState): void {
  if (st.dirty && !target.isStart && !ctx.run.created.has(target.id) && !ctx.run.snapshotted.has(target.id)) {
    ctx.document.snapshot(target.id, `Auto-save before the assistant changed "${target.title}"`)
    ctx.run.snapshotted.add(target.id)
  }
  commitHtml(ctx, target.id, st.dirty ? diffHtml(st.reviewBase, st.html) : st.original)
}

/** Every store write of the run goes through here: what it stores is the run's own, not a user edit. */
function commitHtml(ctx: ToolContext, id: string, html: string): void {
  ctx.document.commit(id, html)
  ctx.run.known.set(id, storedContent(ctx, id))
}

/** Record what a chapter received, for the bubble's "changed this turn" block. */
export function touch(ctx: ToolContext, target: Target, kind: AgentTouchedChapter['kind'], changes: number, failed: number): void {
  const prev = ctx.run.touched.get(target.id)
  const rank = { created: 4, rewrite: 3, polished: 2, selection: 1, edits: 0 } as const
  const nextKind = ctx.run.created.has(target.id) ? 'created'
    : prev && rank[prev.kind] > rank[kind] ? prev.kind : kind
  ctx.run.touched.set(target.id, {
    documentId: target.id,
    titleAtRun: target.title,
    kind: nextKind,
    changes: (prev?.changes ?? 0) + changes,
    failed: (prev?.failed ?? 0) + failed
  })
}

/**
 * A chapter created this run is opened in the editor when its first write
 * starts, so a brand-new chapter keeps the live preview (D6). It is empty and
 * nobody was editing it, so the switch interrupts nothing; a chapter that
 * already existed never moves the user's view.
 */
function openIfCreated(ctx: ToolContext, target: Target): void {
  // Never once the user has gone to another chapter: they may be typing there.
  if (ctx.run.created.has(target.id) && ctx.document.openId() !== target.id && !ctx.document.userMoved()) {
    ctx.document.open(target.id)
  }
}

/** Run `fn` once the target's content is loaded — synchronously for the start chapter. */
export function withLoaded(ctx: ToolContext, target: Target, fn: () => ToolResult | Promise<ToolResult>): ToolResult | Promise<ToolResult> {
  if (target.isStart) return fn()
  return ctx.document.ensureLoaded([target.id]).then(fn)
}

const unseen = (target: Target): ToolResult => ({
  ok: false,
  retryable: true,
  content: `You have not seen the current HTML of ${citeChapter(target)} in this turn, so SEARCH text cannot be copied from it. ` +
    `Call read_chapter with chapters=[${target.number}] and format="html" first.`,
  trace: `⛔ edit of ${citeChapter(target)} refused — not read yet`
})

/**
 * Live rendering of a full rewrite, routed by its target.
 *
 * Another chapter's text must never paint over the one that is open: a
 * rewrite of a chapter the user is not looking at shows as a progress line in
 * the bubble instead. A chapter created this run is opened first (D6).
 * An unresolvable target (typically a chapter created in this same reply)
 * shows as progress; the write itself resolves it once the reply ends.
 */
export function previewRewrite(ctx: ToolContext, chapterRef: unknown, html: string): void {
  const target = resolveTarget(chapterRef, ctx)
  if (typeof target === 'string') {
    // A chapter created in this same reply does not exist until the reply
    // ends (tools run after it). Show the writing as progress, not nothing.
    ctx.ui.progress(`✍️ "${String(chapterRef)}" … ${htmlToPlainText(html).length.toLocaleString()} chars`)
    return
  }
  // A chapter the user changed meanwhile: this rewrite will be refused, so
  // it must not paint over what they wrote.
  if (!userEdited(ctx, target.id)) openIfCreated(ctx, target)
  if (ctx.document.openId() !== target.id || userEdited(ctx, target.id)) {
    ctx.ui.progress(`✍️ ${citeChapter(target)} … ${htmlToPlainText(html).length.toLocaleString()} chars`)
    return
  }
  ctx.editor.previewDocument(html)
}

/**
 * The value of a top-level key in still-arriving JSON, once it is complete:
 * a closed string, or a number followed by `,` or `}`. Undefined otherwise.
 */
function completeScalarArgument(text: string, key: string): string | number | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|(-?\\d+)\\s*[,}])`).exec(text)
  if (!m) return undefined
  if (m[1] !== undefined) {
    try { return JSON.parse(`"${m[1]}"`) as string } catch { return undefined }
  }
  return Number(m[2])
}

const chapterArg = (raw: Record<string, unknown> | null): unknown => raw?.chapter
const htmlArg = (raw: Record<string, unknown> | null) =>
  raw && typeof raw.html === 'string' ? raw.html : ''

// ── update_document ─────────────────────────────────────────────────────────

export const updateDocumentTool = defineTool<{ html: string; chapter: unknown; argumentsLost: boolean }>({
  ...schemaOf('update_document'),
  kind: 'write',
  markupForm: true,
  isAvailable: () => true,
  // Unparseable arguments mean the call was cut off mid-document. That is a
  // truncated rewrite, not an unusable request, and it is reported as one.
  parse: raw => ({ html: htmlArg(raw), chapter: chapterArg(raw), argumentsLost: raw === null }),
  preview: (text, ctx) => {
    // The live preview: the partial `html` argument is readable long before
    // the JSON closes (205 deltas measured on a real stream). The target is
    // known only if `chapter` arrived BEFORE `html`; otherwise the start
    // chapter is assumed and corrected at execution (discardPreview).
    const partial = partialStringArgument(text, 'html')
    if (partial === null) return
    const chapterAt = text.indexOf('"chapter"')
    const ref = chapterAt !== -1 && chapterAt < text.indexOf('"html"')
      ? completeScalarArgument(text, 'chapter')
      : undefined
    previewRewrite(ctx, ref, trimIncompleteHtmlTail(partial))
  },
  execute: ({ html, chapter, argumentsLost }, ctx, call): ToolResult | Promise<ToolResult> => {
    const target = resolveTarget(chapter, ctx)
    if (typeof target === 'string') return { ok: false, retryable: true, content: target, trace: `⚠️ rewrite: ${target.split('\n')[0]}` }
    ctx.ui.progress(null)
    if (ctx.document.openId() !== target.id) ctx.editor.discardPreview()

    return withLoaded(ctx, target, () => {
      if (userEdited(ctx, target.id)) return editedMeanwhile(ctx, target)
      const closed = !argumentsLost && call.unclosed !== true
      if (closed && !html.trim()) {
        return { ok: false, content: 'update_document had an empty html argument; nothing was written.', trace: '⚠️ rewrite: empty', effects: { producedNothing: true } }
      }
      // A full rewrite of the selection's chapter would overwrite the
      // selection's own pending diff.
      if (target.isStart && ctx.run.selectionAttempted) {
        return { ok: false, retryable: false, content: `${citeChapter(target)} has a selection rewrite in this turn; a full rewrite would overwrite it.`, trace: '⚠️ rewrite skipped: it would overwrite the selection rewrite' }
      }
      const st = docState(ctx, target)
      if (!ctx.run.htmlShown.has(target.id) && !isBlankContent(st.html)) return unseen(target)

      // Guard the destructive full-document replacement: a response that was
      // cut off, or that abbreviates unchanged regions with placeholders,
      // would silently delete content. Keep what the run has and say so.
      const candidate = stripBlankParagraphs(ctx.images.restore(html))
      const issue = validateCanvasReplacement(candidate, closed)
      if (issue) {
        commitDoc(ctx, target, st)
        return {
          ok: false,
          // Retrying runs into the same output limit or the same shortcut.
          retryable: false,
          content: issue === 'truncated'
            ? 'The rewrite was cut off before it finished, so it was not applied.'
            : 'The rewrite abbreviated unchanged parts of the document, so applying it would have deleted content. It was not applied.',
          trace: `⚠️ rewrite of ${citeChapter(target)} not applied (${issue})`,
          effects: { canvasIssue: issue }
        }
      }

      openIfCreated(ctx, target)
      // Image safety net: an image whose placeholder token the model dropped
      // is re-inserted near its original position instead of vanishing.
      const { html: rewritten, reinserted } = reinsertMissingImages(candidate, st.original)
      st.html = rewritten
      st.dirty = true
      commitDoc(ctx, target, st)
      // The model wrote it, so it knows the current bytes.
      ctx.run.htmlShown.add(target.id)
      touch(ctx, target, 'rewrite', 1, 0)
      return {
        ok: true,
        content: `${citeChapter(target)} was rewritten.`,
        trace: `✏️ rewrote ${citeChapter(target)}`,
        effects: { reinsertedImages: reinserted }
      }
    })
  }
})

// ── edit_document ───────────────────────────────────────────────────────────

export const editDocumentTool = defineTool<{ edits: EditBlock[]; chapter: unknown }>({
  ...schemaOf('edit_document'),
  kind: 'write',
  markupForm: true,
  isAvailable: () => true,
  parse: raw => {
    if (!raw) return 'its arguments could not be parsed'
    const list = Array.isArray(raw.edits) ? raw.edits : []
    const edits = list
      .filter((e): e is { search: string; replace?: unknown } =>
        !!e && typeof e === 'object' && typeof (e as { search?: unknown }).search === 'string')
      .map(e => ({ search: e.search, replace: typeof e.replace === 'string' ? e.replace : '' }))
    return edits.length > 0 ? { edits, chapter: chapterArg(raw) } : 'it contained no usable edit (each needs a "search" string)'
  },
  execute: ({ edits, chapter }, ctx): ToolResult | Promise<ToolResult> => {
    const target = resolveTarget(chapter, ctx)
    if (typeof target === 'string') return { ok: false, retryable: true, content: target, trace: `⚠️ edit: ${target.split('\n')[0]}` }
    if (!ctx.run.htmlShown.has(target.id)) return unseen(target)

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
      if (applied > 0 || failed.length > 0) touch(ctx, target, 'edits', applied, failed.length)
      return {
        ok: failed.length === 0,
        content: failed.length === 0
          ? `Applied ${applied} edit(s) to ${citeChapter(target)}.`
          : `Applied ${applied} of ${edits.length} edit(s) to ${citeChapter(target)}. These SEARCH texts were not found in its current HTML — copy them exactly from the document, or read it again:\n` +
            failed.map(f => `- ${f.search}`).join('\n'),
        trace: failed.length === 0
          ? `✏️ edited ${citeChapter(target)} (${applied} change${applied === 1 ? '' : 's'})`
          : `⚠️ edited ${citeChapter(target)}: ${applied} of ${edits.length} located`,
        effects: { failedEdits: failed.length }
      }
    }

    // Edits that come with a selection rewrite target text OUTSIDE the
    // selection. They land on the rewritten document as local diffs, so the
    // selection's own diff stays pending for review. Without a placed
    // selection there is no trustworthy document to apply them to (the
    // chapter may have been switched) — they are reported instead.
    if (target.isStart && ctx.run.selectionAttempted) {
      const editor = ctx.editor.current()
      if (!ctx.run.selectionApplied || !editor) return { ...report(edits, ' beside the selection'), retryable: false }
      const local = applyEditBlocksLocally(ctx.images.preserve(editor.getHTML()), edits)
      if (local.failed.length < edits.length) commitHtml(ctx, target.id, ctx.images.restore(local.html))
      return report(local.failed, ' beside the selection')
    }

    return withLoaded(ctx, target, () => {
      if (userEdited(ctx, target.id)) return editedMeanwhile(ctx, target)
      // Edits whose SEARCH text can't be located are skipped (never
      // destructive) and reported.
      const st = docState(ctx, target)
      const { html, failed } = applyEditBlocks(ctx.images.preserve(st.html), edits)
      if (failed.length < edits.length) {
        st.html = stripBlankParagraphs(ctx.images.restore(html))
        st.dirty = true
      }
      commitDoc(ctx, target, st)
      return report(failed, '')
    })
  }
})

// ── replace_selection ───────────────────────────────────────────────────────

export const replaceSelectionTool = defineTool<{ html: string }>({
  ...schemaOf('replace_selection'),
  kind: 'write',
  markupForm: true,
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
      return { ok: false, content: 'replace_selection had an empty html argument; nothing was written.', trace: '⚠️ selection rewrite: empty', effects: { producedNothing: true } }
    }

    const editor = ctx.editor.current()
    if (editor) ctx.selection.relocate()
    const range = ctx.selection.range()
    if (!editor || !range) {
      return { ok: false, retryable: false, content: 'The selection could not be found in the editor.', trace: '⚠️ selection rewrite: no selection' }
    }

    const target = resolveTarget(undefined, ctx)
    const restored = stripBlankParagraphs(ctx.images.restore(cleaned))
    const diffed = diffHtml(ctx.selection.originalText(), restored)
    // The selection lives in the chapter the turn started on; if another one
    // is open now, the range points into the wrong document.
    const placed = typeof target !== 'string' && ctx.document.openId() === target.id &&
      ctx.editor.replaceRange(range.from, ctx.selection.end() ?? range.to, diffed) !== null
    if (!placed || typeof target === 'string') {
      // The selection is gone (chapter switched, document shortened). Say so
      // rather than throwing the turn away: the text is in the chat for the
      // user to place themselves.
      return {
        ok: false,
        retryable: false,
        content: 'The selected text is no longer where it was, so nothing was written.',
        trace: '⚠️ selection rewrite: the selection is gone',
        effects: { selectionGone: true }
      }
    }
    commitHtml(ctx, target.id, editor.getHTML())
    ctx.run.selectionApplied = true
    touch(ctx, target, 'selection', 1, 0)
    return { ok: true, content: 'The selection was rewritten.', trace: '✏️ rewrote the selection' }
  }
})

export const DOCUMENT_WRITE_TOOLS = [updateDocumentTool, editDocumentTool, replaceSelectionTool]
