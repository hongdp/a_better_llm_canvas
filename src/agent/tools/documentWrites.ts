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
import { chapterChars } from '../../utils/paragraphs'
import { contentWithRenamedHeading, leadingH1Text } from '../../utils/titleSync'

const schemaOf = (name: DocumentToolName) => {
  const tool = DOCUMENT_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`No schema for ${name}`)
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

// ── Targets ─────────────────────────────────────────────────────────────────

export interface Target extends ResolvedChapter {
  isStart: boolean
}

/**
 * A write that creates its chapter: `<canvas new_chapter="title">` in the
 * markup protocol, update_document's `new_chapter` argument with tools.
 */
export interface NewChapterRef {
  create: string
}

export const isNewChapterRef = (ref: unknown): ref is NewChapterRef =>
  !!ref && typeof ref === 'object' && typeof (ref as NewChapterRef).create === 'string' && (ref as NewChapterRef).create.trim() !== ''

/** Titles match ignoring whitespace: "第二章 风起" is "第二章风起". */
const titleKey = (title: string) => title.replace(/\s+/g, '')

/** A title's leading chapter marker: 第二章, 第12回, Chapter 3, 序章… */
const CHAPTER_MARKER_RE = /^(第[零〇一二三四五六七八九十百千两\d]+[章节回卷部集篇]|chapter\s*\d+|ch\.?\s*\d+|序章|楔子|尾声|后记)/i
const looseKey = (title: string) => title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

function bigrams(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2))
  return out
}

/** Dice coefficient over character bigrams: 1 = same, 0 = nothing shared. */
function titleSimilarity(a: string, b: string): number {
  const x = bigrams(a)
  const y = bigrams(b)
  if (x.length === 0 || y.length === 0) return 0
  const pool = [...y]
  let shared = 0
  for (const g of x) {
    const i = pool.indexOf(g)
    if (i !== -1) { shared++; pool.splice(i, 1) }
  }
  return (2 * shared) / (x.length + y.length)
}

/**
 * Other chapters whose titles look like this one: the same chapter marker
 * ("第二章 入城" beside "第二章 进城"), one title inside the other, or most
 * of the characters shared. A new chapter with such a sibling may have been
 * meant as a rewrite of it — the model is told, not stopped.
 */
export function similarChapters(title: string, excludeId: string, chapters: Array<{ id: string; title: string }>): Array<{ number: number; title: string }> {
  const key = looseKey(title)
  const marker = CHAPTER_MARKER_RE.exec(title.trim())?.[1].replace(/\s+/g, '').toLowerCase()
  const out: Array<{ number: number; title: string }> = []
  chapters.forEach((c, i) => {
    if (c.id === excludeId) return
    const other = looseKey(c.title)
    if (!other || !key) return
    const otherMarker = CHAPTER_MARKER_RE.exec(c.title.trim())?.[1].replace(/\s+/g, '').toLowerCase()
    // 第二章 and 第三章 are different chapters, however alike the rest reads.
    if (marker !== undefined && otherMarker !== undefined && marker !== otherMarker) return
    const similar = (marker !== undefined && marker === otherMarker) ||
      (Math.min(key.length, other.length) >= 2 && (key.includes(other) || other.includes(key))) ||
      titleSimilarity(key, other) >= 0.6
    if (similar) out.push({ number: i + 1, title: c.title })
  })
  return out.slice(0, 3)
}

/** How to write a whole existing chapter, in the form this model uses. */
const fullWrite = (ctx: ToolContext, number: number) => ctx.run.writeProtocol === 'markup'
  ? `<canvas chapter="${number}">…</canvas>`
  : `update_document with chapter="${number}"`

/** Open a chapter the run is about to write into — unless the user is elsewhere. */
function openForWriting(ctx: ToolContext, id: string): void {
  // Not while a selection rewrite is pending: the selection lives in the
  // open chapter. Nor once the user has gone to another chapter: they may be
  // typing there.
  const selectionPending = ctx.selection.range() !== null && !ctx.run.selectionApplied
  if (!selectionPending && !ctx.document.userMoved() && ctx.document.openId() !== id) ctx.document.open(id)
}

/**
 * The chapter a creating write fills, created the first time it is seen.
 *
 * Problem: a new chapter took two model calls — create_chapter, then the
 *   write. grok planned the chapter in the first call's reasoning (105–158 s
 *   measured) and emitted only the create; that reasoning is not carried to
 *   the next call, so the second planned again (up to 33 s) — or claimed the
 *   chapter was written and wrote nothing (2026-10-06). A 19-chapter run
 *   spent 21 of its 40 steps on a lone create_chapter.
 * Fix: creating IS writing. There is no empty create: the chapter is made
 *   by the write that fills it — at the end of the book, opened, and with
 *   the markup protocol as soon as the opening tag has streamed, so the live
 *   preview runs in it. Every later sight in the run (each chunk's preview,
 *   the write, a retry) finds the same chapter.
 *
 * A chapter of that title the run did not create is written only if it is
 * empty (the user made it to be filled, or a reload restarted the run after
 * the preview created it). One with text is refused: rewriting it is a
 * write to its number.
 */
function claimNewChapter(title: string, ctx: ToolContext): Target | string {
  const chapters = ctx.document.chapters()
  const index = chapters.findIndex(c => titleKey(c.title) === titleKey(title))
  if (index !== -1) {
    const chapter = chapters[index]
    if (!ctx.run.created.has(chapter.id)) {
      if (chapter.loaded === false || !isBlankContent(chapter.content)) {
        return `A chapter titled "${chapter.title}" already exists as #${index + 1}. To rewrite it, write to it by number: ${fullWrite(ctx, index + 1)}.`
      }
      // Empty: nothing to read before writing, nothing to lose.
      ctx.run.htmlShown.add(chapter.id)
      ctx.run.inContext.add(chapter.id)
      if (!ctx.run.known.has(chapter.id)) ctx.run.known.set(chapter.id, chapter.content)
      openForWriting(ctx, chapter.id)
    }
    return { id: chapter.id, title: chapter.title, number: index + 1, isStart: chapter.id === ctx.document.startId }
  }
  const id = ctx.document.create(title.trim())
  const after = ctx.document.chapters()
  const number = after.findIndex(c => c.id === id) + 1
  ctx.run.created.add(id)
  ctx.run.htmlShown.add(id)
  ctx.run.inContext.add(id)
  ctx.run.known.set(id, after[number - 1]?.content ?? '')
  ctx.run.touched.set(id, { documentId: id, titleAtRun: title.trim(), kind: 'created', changes: 0, failed: 0 })
  openForWriting(ctx, id)
  return { id, title: title.trim(), number, isStart: false }
}

/**
 * Which chapter a write goes to. Absent = the chapter the turn started on.
 * A new-chapter reference creates the chapter (claimNewChapter).
 */
export function resolveTarget(ref: unknown, ctx: ToolContext): Target | string {
  if (isNewChapterRef(ref)) return claimNewChapter(ref.create, ctx)
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
  const rank = { created: 4, rewrite: 3, polished: 2, selection: 1, edits: 0, renamed: -1 } as const
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
  if (ctx.run.created.has(target.id)) openForWriting(ctx, target.id)
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
 * the bubble instead. A new chapter is created here, on the write's first
 * chunk, and opened (claimNewChapter) — so its text streams into it. A
 * reference the write will refuse shows as progress.
 */
export function previewRewrite(ctx: ToolContext, chapterRef: unknown, html: string): void {
  const openBefore = ctx.document.openId()
  const target = resolveTarget(chapterRef, ctx)
  if (typeof target === 'string') {
    // A reference the write will refuse (no such chapter, or a new chapter
    // whose title is taken). Show the writing as progress, not nothing.
    const name = isNewChapterRef(chapterRef) ? chapterRef.create : String(chapterRef)
    ctx.ui.progress(`✍️ "${name}" … ${htmlToPlainText(html).length.toLocaleString()} chars`)
    return
  }
  // A chapter the user changed meanwhile: this rewrite will be refused, so
  // it must not paint over what they wrote.
  if (!userEdited(ctx, target.id)) openIfCreated(ctx, target)
  if (ctx.document.openId() !== target.id || userEdited(ctx, target.id)) {
    ctx.ui.progress(`✍️ ${citeChapter(target)} … ${htmlToPlainText(html).length.toLocaleString()} chars`)
    return
  }
  // Opened by this very chunk: the editor on screen is still the previous
  // chapter's until React renders the new one, and painting now would put
  // this chapter's text into it. The text accumulates, so the next chunk
  // paints all of it, in the right editor.
  if (openBefore !== target.id) return
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
/** update_document's target: a new chapter by title wins over `chapter`. */
const rewriteTarget = (raw: Record<string, unknown> | null): unknown =>
  typeof raw?.new_chapter === 'string' && raw.new_chapter.trim() ? { create: raw.new_chapter.trim() } : chapterArg(raw)
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
  parse: raw => ({ html: htmlArg(raw), chapter: rewriteTarget(raw), argumentsLost: raw === null }),
  preview: (text, ctx) => {
    // The live preview: the partial `html` argument is readable long before
    // the JSON closes (205 deltas measured on a real stream). The target is
    // known only if `chapter` arrived BEFORE `html`; otherwise the start
    // chapter is assumed and corrected at execution (discardPreview).
    const partial = partialStringArgument(text, 'html')
    if (partial === null) return
    const htmlAt = text.indexOf('"html"')
    const before = (key: string) => {
      const at = text.indexOf(`"${key}"`)
      return at !== -1 && at < htmlAt
    }
    const created = before('new_chapter') ? completeScalarArgument(text, 'new_chapter') : undefined
    const ref = typeof created === 'string' && created.trim()
      ? { create: created.trim() }
      : before('chapter') ? completeScalarArgument(text, 'chapter') : undefined
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
      const charsBefore = chapterChars(st.html)
      // Image safety net: an image whose placeholder token the model dropped
      // is re-inserted near its original position instead of vanishing.
      const { html: rewritten, reinserted } = reinsertMissingImages(candidate, st.original)
      st.html = rewritten
      st.dirty = true
      commitDoc(ctx, target, st)
      // The model wrote it, so it knows the current bytes.
      ctx.run.htmlShown.add(target.id)
      touch(ctx, target, 'rewrite', 1, 0)
      // Its length, counted like a read: the model cannot count its own
      // output, and said "as long as the source" of a rewrite at 76% of it.
      const chars = chapterChars(st.html)
      /*
       * Creating and rewriting answer differently (user request, 2026-10-06):
       * a model that meant to rewrite "第二章 进城" and wrote
       * new_chapter="第二章 入城" must learn it ADDED a chapter, and how to
       * undo that without writing the text again.
       */
      if (isNewChapterRef(chapter) && ctx.run.created.has(target.id)) {
        const chapters = ctx.document.chapters()
        const similar = similarChapters(target.title, target.id, chapters)
        const hint = similar.length === 0 ? '' :
          ` Note: ${similar.map(c => `#${c.number} "${c.title}"`).join(', ')} ${similar.length === 1 ? 'has a similar title' : 'have similar titles'}. ` +
          `If you meant to rewrite #${similar[0].number} rather than add a chapter, do not write it again: call rename_chapter with chapter="${target.number}", title="${similar[0].title}" and replace=true — ` +
          `the text you just wrote takes #${similar[0].number}'s place (as a change the user reviews) and #${target.number} is removed. If a new chapter is what you meant, ignore this.`
        return {
          ok: true,
          content: `Created a NEW chapter ${citeChapter(target)} at the end of the book and wrote it (${chars} characters). The book now has ${chapters.length} chapters.${hint}`,
          trace: `➕ wrote new ${citeChapter(target)} (${chars} chars)`,
          effects: { reinsertedImages: reinserted }
        }
      }
      return {
        ok: true,
        content: `Rewrote the EXISTING chapter ${citeChapter(target)}: it had ${charsBefore} characters and now has ${chars}. No chapter was added.`,
        trace: `✏️ rewrote ${citeChapter(target)} (${chars} chars)`,
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

    const report = (failed: EditBlock[], where: string, chars?: number, underReview: EditBlock[] = []): ToolResult => {
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
      // Located but refused is not "not found": telling a model to re-copy a
      // SEARCH that was right only gets the same SEARCH back.
      const notFound = failed.filter(f => !underReview.includes(f))
      const list = (blocks: EditBlock[]) => blocks.map(f => `- ${f.search}`).join('\n')
      return {
        ok: failed.length === 0,
        content: failed.length === 0
          ? `Applied ${applied} edit(s) to ${citeChapter(target)}.${chars === undefined ? '' : ` It now has ${chars} characters.`}`
          : `Applied ${applied} of ${edits.length} edit(s) to ${citeChapter(target)}.` +
            (notFound.length > 0
              ? ` These SEARCH texts were not found in its current HTML — copy them exactly from the document, or read it again:\n${list(notFound)}`
              : '') +
            (underReview.length > 0
              ? `\nThese were found, but they change text that is still under review — text a pending change deletes, or across the edge of a pending change — so they were not applied. Change only text that lies wholly inside the new wording, or wholly outside any pending change:\n${list(underReview)}`
              : ''),
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
      if (!ctx.run.selectionApplied) return { ...report(edits, ' beside the selection'), retryable: false }
      // The chapter as it is now: the live editor when it shows this chapter,
      // the stored text when the user has opened another one. The editor then
      // holds THAT chapter — editing its HTML and committing it here would
      // write one chapter's text over another.
      const editor = ctx.editor.current()
      const current = editor && ctx.document.openId() === target.id ? editor.getHTML() : storedContent(ctx, target.id)
      const local = applyEditBlocksLocally(ctx.images.preserve(current), edits)
      if (local.failed.length < edits.length) commitHtml(ctx, target.id, ctx.images.restore(local.html))
      return report(local.failed, ' beside the selection', undefined, local.underReview)
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
      return report(failed, '', chapterChars(st.html))
    })
  }
})

// ── replace_selection ───────────────────────────────────────────────────────

const BLOCK_START_RE = /^\s*<(?:p|h[1-6]|blockquote|ul|ol|li|div)\b/i
const SINGLE_P_RE = /^\s*<p(?:\s[^>]*)?>((?:(?!<\/?p\b)[\s\S])*)<\/p>\s*$/i

/**
 * A selection's text and its rewrite as one stored-HTML edit. The editor
 * places an open slice itself; in stored HTML the block structure has to
 * line up by hand. A selection inside one paragraph serializes as inline
 * text while its rewrite comes back as `<p>…</p>`, and swapping one for
 * the other nests a paragraph in a paragraph. So:
 *  - a selection that is a whole paragraph's text is replaced as that block;
 *  - one that is part of a paragraph takes a single-paragraph rewrite's
 *    inner HTML;
 *  - a multi-paragraph rewrite of part of a paragraph cannot be placed
 *    cleanly (null).
 */
function alignSelectionBlocks(base: string, search: string, replace: string): EditBlock | null {
  if (!search.trim() || BLOCK_START_RE.test(search)) return { search, replace }
  if (base.includes(`<p>${search}</p>`)) return { search: `<p>${search}</p>`, replace }
  const single = SINGLE_P_RE.exec(replace)
  if (single) return { search, replace: single[1] }
  return BLOCK_START_RE.test(replace) ? null : { search, replace }
}

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
    const target = resolveTarget(undefined, ctx)
    const gone: ToolResult = {
      ok: false,
      retryable: false,
      content: 'The selected text is no longer where it was, so nothing was written.',
      trace: '⚠️ selection rewrite: the selection is gone',
      effects: { selectionGone: true }
    }
    if (typeof target === 'string') return gone

    const restored = stripBlankParagraphs(ctx.images.restore(cleaned))
    const done = (): ToolResult => {
      ctx.run.selectionApplied = true
      touch(ctx, target, 'selection', 1, 0)
      return { ok: true, content: 'The selection was rewritten.', trace: '✏️ rewrote the selection' }
    }

    // On screen: through the editor, at the captured range. A range that no
    // longer fits means the document changed under the reply — reported, not
    // forced in from the turn's original over whatever is there now.
    if (ctx.document.openId() === target.id) {
      if (!editor || !range) {
        return { ok: false, retryable: false, content: 'The selection could not be found in the editor.', trace: '⚠️ selection rewrite: no selection' }
      }
      if (ctx.editor.replaceRange(range.from, ctx.selection.end() ?? range.to, diffHtml(ctx.selection.originalText(), restored)) === null) return gone
      commitHtml(ctx, target.id, editor.getHTML())
      return done()
    }
    if (!ctx.selection.originalText()) return gone

    /*
     * Problem: the user may open another chapter while the run works, and
     *   then the range points into a document no longer on screen. The
     *   rewrite was dropped as "the selection is gone" (2026-10-06: 2510
     *   characters lost) — and a selection preview that had already
     *   streamed part of it into the store stayed there, half-written.
     * Fix: place it in the stored chapter by its text instead, from the
     *   turn's original. The selection's chapter is locked for the whole
     *   turn, so nothing but this run has changed it since — and starting
     *   from the original also replaces any half-streamed preview.
     */
    const base = ctx.images.preserve(ctx.document.original)
    const aligned = alignSelectionBlocks(base, ctx.images.preserve(ctx.selection.originalText()), ctx.images.preserve(restored))
    const placed = aligned ? applyEditBlocksLocally(base, [aligned]) : null
    if (placed && placed.failed.length === 0) {
      commitHtml(ctx, target.id, ctx.images.restore(placed.html))
      return done()
    }
    // Not found either: say so, and take back a half-streamed preview.
    if (storedContent(ctx, target.id) !== ctx.document.original) commitHtml(ctx, target.id, ctx.document.original)
    return gone
  }
})

export const DOCUMENT_WRITE_TOOLS = [updateDocumentTool, editDocumentTool, replaceSelectionTool]

// ── rename_chapter ──────────────────────────────────────────────────────────

/**
 * Rename a chapter — and, for a chapter this run created under a slightly
 * wrong title, let it take the place of the chapter it was meant to rewrite.
 *
 * Problem (user request, 2026-10-06): a model that meant to rewrite
 *   "第二章 进城" could write new_chapter="第二章 入城" instead. Fixing it
 *   meant writing the whole text again. Deleting the original and renaming
 *   the new one would also move the chapter to the END of the book, and a
 *   chapter with text is the user's to delete.
 * Fix: `replace=true` moves the new chapter's text into the original — in
 *   place, under its title, as a change the user reviews (accept/reject,
 *   with a version snapshot before it) — and removes the new chapter. Only
 *   a chapter this run created can do that: its text is the model's own, so
 *   a rejected review loses nothing of the user's.
 */
export const renameChapterTool = defineTool<{ chapter: unknown; title: string; replace: boolean }>({
  name: 'rename_chapter',
  description:
    'Rename a chapter. If another chapter already has that title — typically you created a chapter under a slightly different title when you meant to rewrite that one — ' +
    'set replace=true: the chapter you created this turn gives its text to the one with that title (in place, as a change the user reviews) and is removed. Nothing needs to be written again.',
  parameters: {
    type: 'object',
    properties: {
      chapter: { type: 'string', description: 'The chapter to rename: its number in the CHAPTER INDEX, or its exact title.' },
      title: { type: 'string', description: 'The new title.' },
      replace: { type: 'boolean', description: 'Only when another chapter has this title: move this chapter\'s text into that one and remove this chapter. Only for a chapter you created this turn.' }
    },
    required: ['chapter', 'title']
  },
  kind: 'write',
  // After the reply's other calls: its write may be what creates the chapter
  // being renamed, and a replacement removes a chapter (renumbering).
  runLast: true,
  isAvailable: () => true,
  parse: raw => {
    if (!raw || raw.chapter === undefined) return 'no chapter was named'
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (!title) return 'the new title was empty'
    return { chapter: raw.chapter, title, replace: raw.replace === true || raw.replace === 'true' }
  },
  execute: ({ chapter, title, replace }, ctx): ToolResult | Promise<ToolResult> => {
    const source = resolveTarget(chapter, ctx)
    if (typeof source === 'string') return { ok: false, retryable: true, content: source, trace: `⚠️ rename: ${source.split('\n')[0]}` }
    const chapters = ctx.document.chapters()
    const holderIndex = chapters.findIndex(c => c.id !== source.id && titleKey(c.title) === titleKey(title))

    if (holderIndex === -1) {
      if (source.title === title) {
        return { ok: true, content: `${citeChapter(source)} already has that title.`, trace: `✏️ ${citeChapter(source)} already so titled` }
      }
      ctx.document.rename(source.id, title)
      touch(ctx, { ...source, title }, 'renamed', 0, 0)
      const heading = leadingH1Text(storedContent(ctx, source.id))
      return {
        ok: true,
        content: `Renamed #${source.number} from "${source.title}" to "${title}".` +
          (heading && heading !== title ? ` Its first heading still reads "${heading}"; change it with an edit if it should match.` : ''),
        trace: `🏷 renamed #${source.number} "${source.title}" → "${title}"`
      }
    }

    const holder = { ...chapters[holderIndex], number: holderIndex + 1 }
    const holderTarget: Target = { id: holder.id, title: holder.title, number: holder.number, isStart: holder.id === ctx.document.startId }
    if (!replace) {
      return {
        ok: false,
        retryable: true,
        content: `#${holder.number} "${holder.title}" already has that title, and two chapters must not share one. ` +
          (ctx.run.created.has(source.id)
            ? `If ${citeChapter(source)} was meant as a rewrite of #${holder.number}, call rename_chapter again with replace=true: its text takes #${holder.number}'s place and ${citeChapter(source)} is removed.`
            : 'Choose another title.'),
        trace: `⚠️ rename of ${citeChapter(source)} refused — the title is taken by #${holder.number}`
      }
    }
    const refuse = (content: string, why: string): ToolResult =>
      ({ ok: false, retryable: false, content, trace: `⚠️ ${citeChapter(source)} did not replace #${holder.number} — ${why}` })
    if (!ctx.run.created.has(source.id) || userEdited(ctx, source.id)) {
      return refuse(`Only a chapter you created in this turn can take another chapter's place; ${citeChapter(source)} was not, so nothing changed. To rewrite #${holder.number}, write to it.`, 'not created this turn')
    }
    if (holderTarget.isStart && ctx.run.selectionAttempted) {
      return refuse(`#${holder.number} has a selection rewrite in this turn; replacing its text would overwrite it.`, 'it has a selection rewrite')
    }

    return Promise.resolve(ctx.document.ensureLoaded([holder.id])).then((): ToolResult => {
      if (ctx.document.chapters().find(c => c.id === holder.id)?.loaded === false) {
        return refuse(`#${holder.number} could not be loaded, so its text was not replaced.`, 'not loaded')
      }
      if (userEdited(ctx, holder.id)) return editedMeanwhile(ctx, holderTarget)
      const text = docState(ctx, source).html
      if (isBlankContent(text)) return refuse(`${citeChapter(source)} is empty: there is no text to move.`, 'it is empty')

      const wasOpen = ctx.document.openId() === source.id
      const st = docState(ctx, holderTarget)
      // The text was written under the wrong title; its heading follows the
      // chapter it now belongs to.
      st.html = contentWithRenamedHeading(text, holder.title) ?? text
      st.dirty = true
      commitDoc(ctx, holderTarget, st)
      ctx.run.htmlShown.add(holder.id)
      touch(ctx, holderTarget, 'rewrite', 1, 0)

      ctx.document.remove(source.id)
      forgetChapter(ctx, source.id)
      ctx.run.created.delete(source.id)
      ctx.run.inContext.delete(source.id)
      ctx.run.touched.delete(source.id)
      if (wasOpen) openForWriting(ctx, holder.id)

      const holderNow = ctx.document.chapters().findIndex(c => c.id === holder.id) + 1
      const after = chapters.length - source.number
      return {
        ok: true,
        content: `#${holderNow} "${holder.title}" now has the text of ${citeChapter(source)} (${chapterChars(st.html)} characters), as a change the user reviews; ${citeChapter(source)} was removed.` +
          (after > 0 ? ` The ${after} chapter(s) after #${source.number} moved up by one.` : ''),
        trace: `🔀 #${source.number} "${source.title}" → replaced #${holderNow} "${holder.title}"`
      }
    })
  }
})
