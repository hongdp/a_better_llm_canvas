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
import { replaceInHtmlText } from '../../utils/textReplace'
import { htmlToPlainText } from '../../utils/llmContext'
import { chapterChars, isTextRewritableHtml, rewriteLoss, rewriteLossNote, stripImageMarkerParagraphs } from '../../utils/paragraphs'
import { hashContent } from '../../utils/contextLedger'
import { contentWithRenamedHeading, leadingH1Text } from '../../utils/titleSync'
import { nearestHint } from '../../utils/editHints'
import { applyParagraphEdits, type ParagraphAction, type ParagraphEdit } from '../../utils/paragraphs'
import { PLAN_DONE_PARAMETER, planDoneArg, withPlanDone } from './plan'

const schemaOf = (name: DocumentToolName) => {
  const tool = DOCUMENT_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`No schema for ${name}`)
  // Every write may finish plan items (agentic_chat_loop.md §0.11).
  return {
    name: tool.name,
    description: tool.description,
    parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, plan_done: PLAN_DONE_PARAMETER } }
  }
}

/** A tool result once it is ready — synchronously when it already is. */
const then = (r: ToolResult | Promise<ToolResult>, fn: (r: ToolResult) => ToolResult): ToolResult | Promise<ToolResult> =>
  r instanceof Promise ? r.then(fn) : fn(r)

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
 * A chapter of that title the run did not create is never duplicated. An
 * empty one is filled (the user made it to be filled, or a reload restarted
 * the run after the preview created it). One with text is rewritten: the
 * model named it exactly, and that is the chapter it means.
 *   Problem: refusing it threw the whole reply away. Measured 2026-10-06:
 *     asked to expand chapter 2, grok called create_chapter("第二章 …") on
 *     the chapter it was expanding. With create_chapter that cost one
 *     refused call; with new_chapter the same mistake would have discarded
 *     a 4,362-character rewrite, and the model writes it all again.
 *   Fix: write it as the rewrite it is, under every rule a rewrite has (the
 *     seen-content rule, the user-edit rule, a reviewable diff, a snapshot),
 *     and say so in the result: no chapter was added.
 */
function claimNewChapter(title: string, ctx: ToolContext): Target | string {
  const chapters = ctx.document.chapters()
  const index = chapters.findIndex(c => titleKey(c.title) === titleKey(title))
  if (index !== -1) {
    const chapter = chapters[index]
    if (!ctx.run.created.has(chapter.id) && chapter.loaded !== false && isBlankContent(chapter.content)) {
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

export const storedContent = (ctx: ToolContext, id: string) =>
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
 *
 * Accepting a pending diff is not an edit (reviewResolved).
 */
export function userEdited(ctx: ToolContext, id: string): boolean {
  if (id === ctx.document.startId && selectionTurn(ctx)) return false
  const known = ctx.run.known.get(id)
  if (known === undefined) return false
  const stored = storedContent(ctx, id)
  if (stored === known) return false
  if (!reviewResolved(known, stored)) return true
  adoptReviewed(ctx, id, stored)
  return false
}

/** A chapter's accepted reading as text alone: what the user reads, whatever HTML spelled it. */
const acceptedTextKey = (html: string) => htmlToPlainText(stripDiffMarkup(html)).replace(/\s+/g, '')

/** The inline formatting of the accepted reading, in order: a bold or italic the user added is an edit. */
const INLINE_TAG = /<(strong|b|em|i|u|s|code|a|mark)\b/gi
const INLINE_ALIAS: Record<string, string> = { b: 'strong', i: 'em' }
const inlineKey = (html: string) =>
  [...stripDiffMarkup(html).matchAll(INLINE_TAG)].map(m => INLINE_ALIAS[m[1].toLowerCase()] ?? m[1].toLowerCase()).join(',')

/**
 * Did the stored chapter change only by the user resolving its review diff,
 * or by the editor spelling the same reading in its own HTML?
 *
 * Problem: "Accept all" while a turn was writing a book (2026-10-14) made
 *   every next write to those chapters refuse "the user edited chapter N
 *   while you were working": accepting rewrites the stored HTML (markup
 *   gone, re-serialized by the editor), so it differed from the run's copy.
 *   The model re-read each chapter, found nothing changed, and redid its
 *   writes — five refused in one step.
 * Fix: a change that leaves the accepted reading's text as it was is a
 *   review decision, not an edit. Accepting (all, or one change) keeps it;
 *   rejecting changes it, and stays an edit the model must read. Text is
 *   compared, not HTML: the editor writes back its own serialization.
 * Problem (2026-10-16): the same refusal after accepting a chapter the run
 *   had just created. Once the run adopted the accepted copy it had no
 *   markup, and this check answered "edited" for any later HTML change —
 *   the editor's next save re-spelled it (`<li><p>`, a trailing `<p></p>`)
 *   with not a character changed.
 * Fix: the rule holds whether or not the run's copy carries markup: the
 *   same text with the same inline formatting is the same chapter.
 */
function reviewResolved(known: string, stored: string): boolean {
  return acceptedTextKey(known) === acceptedTextKey(stored) && inlineKey(known) === inlineKey(stored)
}

/**
 * The run's copy follows what the user accepted: what they accepted is the
 * confirmed text now, so the next write's review diff is drawn from it and
 * does not show the accepted changes again.
 */
function adoptReviewed(ctx: ToolContext, id: string, stored: string): void {
  ctx.run.known.set(id, stored)
  const st = ctx.run.docs.get(id)
  if (!st) return
  st.original = stored
  st.base = stripDiffMarkup(stored)
  st.reviewBase = st.base === stored ? stored : resolveDiffMarkupInHtml(stored, 'reject')
  st.html = st.base
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
      `Read it again (read with chapters=[${target.number}] and format="html") and make the change on its current text, keeping the user's edits.`,
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

/**
 * The model has seen enough of a chapter to rewrite it whole: its HTML this
 * run, or — for a chapter of plain paragraphs, whose text view is its HTML —
 * its whole current text (agentic_chat_loop.md §0.11).
 *
 * Problem: 12 of 24 rewrites in three days of logs were preceded by a step
 *   that only read the chapter's HTML, three more were refused "not read
 *   yet" first; the model had the chapter's whole text in context already.
 * Fix: a rewrite of a plain chapter whose current accepted reading has the
 *   hash the model saw (RunState.textSeen) goes through. Anything the text
 *   view hides (an image, a tag inside a paragraph, a list) still needs the
 *   HTML read.
 */
export function seenEnoughToRewrite(ctx: ToolContext, id: string, acceptedHtml: string): boolean {
  if (ctx.run.htmlShown.has(id)) return true
  const seen = ctx.run.textSeen.get(id)
  return seen !== undefined && seen === hashContent(acceptedHtml) && isTextRewritableHtml(acceptedHtml)
}

const unseen = (target: Target): ToolResult => ({
  ok: false,
  retryable: true,
  content: `You have not seen the current HTML of ${citeChapter(target)} in this turn, so SEARCH text cannot be copied from it. ` +
    `Call read with chapters=[${target.number}] and format="html" first.`,
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
  const chars = htmlToPlainText(html).length.toLocaleString()
  if (typeof target === 'string') {
    // A reference the write will refuse (no such chapter, or a new chapter
    // whose title is taken). Show the writing as progress, not nothing.
    const name = isNewChapterRef(chapterRef) ? chapterRef.create : String(chapterRef)
    ctx.ui.progress(`✍️ "${name}" … ${chars} chars`)
    return
  }
  // A chapter the user changed meanwhile: this rewrite will be refused, so
  // it must not paint over what they wrote.
  if (!userEdited(ctx, target.id)) openIfCreated(ctx, target)
  // The running count shows whether or not the text paints on screen
  // (user request, 2026-10-12: it used to show only for a chapter not open).
  ctx.ui.progress(`✍️ ${citeChapter(target)} … ${chars} chars`)
  if (ctx.document.openId() !== target.id || userEdited(ctx, target.id)) return
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

export const updateDocumentTool = defineTool<{ html: string; chapter: unknown; argumentsLost: boolean; planDone: string[] }>({
  ...schemaOf('update_document'),
  kind: 'write',
  markupForm: true,
  nativeOnMarkup: true,
  isAvailable: () => true,
  // Unparseable arguments mean the call was cut off mid-document. That is a
  // truncated rewrite, not an unusable request, and it is reported as one.
  parse: raw => ({ html: htmlArg(raw), chapter: rewriteTarget(raw), argumentsLost: raw === null, planDone: planDoneArg(raw) }),
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
  execute: ({ html, chapter, argumentsLost, planDone }, ctx, call): ToolResult | Promise<ToolResult> => {
    const target = resolveTarget(chapter, ctx)
    if (typeof target === 'string') return { ok: false, retryable: true, content: target, trace: `⚠️ rewrite: ${target.split('\n')[0]}` }
    ctx.ui.progress(null)
    if (ctx.document.openId() !== target.id) ctx.editor.discardPreview()

    return then(withLoaded(ctx, target, () => {
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
      if (!seenEnoughToRewrite(ctx, target.id, st.html) && !isBlankContent(st.html)) {
        if (isNewChapterRef(chapter)) {
          // A rewrite of text the model never saw could destroy the user's.
          return {
            ok: false,
            retryable: true,
            content: `A chapter titled "${target.title}" already exists as #${target.number} and has text you have not read in this turn, so it was NOT overwritten and no chapter was added. ` +
              `To rewrite it, read it first (read with chapters=[${target.number}]); to add a new chapter, give it a title no chapter has.`,
            trace: `⛔ new_chapter "${target.title}" is #${target.number}, not read — not overwritten`
          }
        }
        return {
          ok: false,
          retryable: true,
          content: `You have not seen the whole current text of ${citeChapter(target)} in this turn, so it was not rewritten. ` +
            (isTextRewritableHtml(st.html)
              ? `Read it (read with chapters=[${target.number}]; text format is enough for this chapter), then write it.`
              : `It has formatting or images a text read does not show: read its HTML (read with chapters=[${target.number}] and format="html"), then write it.`),
          trace: `⛔ rewrite of ${citeChapter(target)} refused — not read yet`
        }
      }

      // Guard the destructive full-document replacement: a response that was
      // cut off, or that abbreviates unchanged regions with placeholders,
      // would silently delete content. Keep what the run has and say so.
      const candidate = stripBlankParagraphs(stripImageMarkerParagraphs(ctx.images.restore(html)))
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

      // A rewrite that would drop a fifth of a chapter, or its headings or
      // list items, is held back once (run-737f3d809b45: "bring the timeline
      // up to chapter 87" folded chapters 1–61 into one line). The model
      // decides: a second send applies it (a split, a requested cut).
      const loss = ctx.run.created.has(target.id) || ctx.run.rewriteLossWarned.has(target.id) ? null : rewriteLoss(st.html, candidate)
      if (loss) {
        ctx.run.rewriteLossWarned.add(target.id)
        commitDoc(ctx, target, st)
        return {
          ok: false,
          retryable: true,
          content: rewriteLossNote(citeChapter(target), loss),
          trace: `⛔ rewrite of ${citeChapter(target)} held back — would drop ${Math.round((1 - loss.after / loss.before) * 100)}% (send again to apply)`
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
        content: (isNewChapterRef(chapter)
          ? `A chapter titled "${target.title}" already existed as #${target.number}, so your new_chapter text rewrote it. `
          : '') +
          `Rewrote the EXISTING chapter ${citeChapter(target)}: it had ${charsBefore} characters and now has ${chars}. No chapter was added.`,
        trace: `✏️ rewrote ${citeChapter(target)} (${chars} chars)`,
        effects: { reinsertedImages: reinserted }
      }
    }), r => withPlanDone(ctx, r, planDone))
  }
})

// ── edit_document ───────────────────────────────────────────────────────────

export const editDocumentTool = defineTool<{ edits: EditBlock[]; chapter: unknown; planDone: string[] }>({
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
    return edits.length > 0 ? { edits, chapter: chapterArg(raw), planDone: planDoneArg(raw) } : 'it contained no usable edit (each needs a "search" string)'
  },
  execute: ({ edits, chapter, planDone }, ctx): ToolResult | Promise<ToolResult> => then(editDocument(edits, chapter, ctx), r => withPlanDone(ctx, r, planDone))
})

function editDocument(edits: EditBlock[], chapter: unknown, ctx: ToolContext): ToolResult | Promise<ToolResult> {
  {
    const target = resolveTarget(chapter, ctx)
    if (typeof target === 'string') return { ok: false, retryable: true, content: target, trace: `⚠️ edit: ${target.split('\n')[0]}` }
    if (!ctx.run.htmlShown.has(target.id)) return unseen(target)

    const report = (failed: EditBlock[], where: string, chars?: number, underReview: EditBlock[] = [], haystack = ''): ToolResult => {
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
      // The paragraph that comes closest, as exact HTML to copy, and what
      // kept the two apart (curly quotes, &nbsp;, an inline tag): this is
      // what saves the re-read step (utils/editHints).
      const near = (blocks: EditBlock[]) => blocks.map(f => [`- ${f.search}`, haystack ? nearestHint(haystack, f.search) : ''].filter(Boolean).join('\n')).join('\n')
      return {
        ok: failed.length === 0,
        content: failed.length === 0
          ? `Applied ${applied} edit(s) to ${citeChapter(target)}.${chars === undefined ? '' : ` It now has ${chars} characters.`}`
          : `Applied ${applied} of ${edits.length} edit(s) to ${citeChapter(target)}.` +
            (notFound.length > 0
              ? ` These SEARCH texts were not found in its current HTML — copy them exactly from the document, or read it again:\n${near(notFound)}`
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
      return report(local.failed, ' beside the selection', undefined, local.underReview, ctx.images.preserve(current))
    }

    return withLoaded(ctx, target, () => {
      if (userEdited(ctx, target.id)) return editedMeanwhile(ctx, target)
      // Edits whose SEARCH text can't be located are skipped (never
      // destructive) and reported.
      const st = docState(ctx, target)
      const before = ctx.images.preserve(st.html)
      const { html, failed } = applyEditBlocks(before, edits)
      if (failed.length < edits.length) {
        st.html = stripBlankParagraphs(ctx.images.restore(html))
        st.dirty = true
      }
      commitDoc(ctx, target, st)
      return report(failed, '', chapterChars(st.html), [], before)
    })
  }
}

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

/**
 * The rewrite without the line breaks that only lay out its tag.
 *
 * Problem: models write `<selection_replace>\n…text…\n</selection_replace>`.
 *   Placed inside a paragraph, each of those breaks became a space —
 *   "蜷得发白。 那根才进了一半多" — and the model then spent four steps
 *   failing to remove them (2026-10-11; also "只管往前顶。 我翻身压上她").
 * Fix: a run of whitespace at either end that contains a line break is
 *   layout, and goes. A plain space at an end is kept: it can be the text's.
 */
export function trimTagLayout(text: string): string {
  return text.replace(/^[ \t]*\r?\n\s*/, '').replace(/\s*\r?\n[ \t]*$/, '')
}

/** A selection rewrite's live preview, with its running character count in the bubble. */
export function previewSelectionWithCount(ctx: ToolContext, html: string): void {
  ctx.ui.progress(`✍️ the selection … ${htmlToPlainText(html).length.toLocaleString()} chars`)
  ctx.editor.previewSelection(html)
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
    if (partial !== null) previewSelectionWithCount(ctx, trimIncompleteHtmlTail(partial).replace(/^[ \t]*\r?\n\s*/, ''))
  },
  execute: ({ html }, ctx): ToolResult => {
    ctx.run.selectionAttempted = true
    ctx.ui.progress(null)
    const cleaned = trimTagLayout(stripIncompleteEndTag(html))
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
      if (!editor) {
        return { ok: false, retryable: false, content: 'The selection could not be found in the editor.', trace: '⚠️ selection rewrite: no selection' }
      }
      // No range after relocating by text: the selected text is not in the
      // document any more. Reported as gone — the bubble then says so and
      // offers the rewrite — rather than as a bare "no selection".
      if (!range) return gone
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

// ── edit_paragraphs ─────────────────────────────────────────────────────────

const PARAGRAPH_ACTIONS: ParagraphAction[] = ['replace', 'insert_before', 'insert_after', 'delete']

/** "12", 12, "¶12": a paragraph number; null for anything else. */
function paragraphNumber(raw: unknown): number | null {
  const m = /^\s*¶?\s*(\d+)\s*$/.exec(String(raw ?? ''))
  return m ? Number(m[1]) : null
}

/**
 * Edits addressed by paragraph number (agentic_chat_loop.md §0.11).
 *
 * Problem: 12 of 17 SEARCH edits in three days of logs were preceded by a
 *   step that only read the chapter's HTML, to copy SEARCH text from it —
 *   after grep or a text read had already shown the paragraph and its ¶.
 * Fix: address the paragraph by that number, anchored by its first words
 *   (Grok Build's hashline edits): the anchor catches a chapter that changed
 *   since, the whole call is refused then, and the result gives the current
 *   text to anchor on. The cut is made in the stored HTML by position
 *   (utils/paragraphs applyParagraphEdits), so nothing else moves.
 */
export const editParagraphsTool = defineTool<{ chapter: unknown; edits: ParagraphEdit[]; planDone: string[] }>({
  name: 'edit_paragraphs',
  description:
    'Change paragraphs of a chapter by their ¶ numbers — the numbers grep and text reads show — with no HTML read and no SEARCH text. ' +
    'Each edit: paragraph (its ¶ number), action ("replace", "insert_before", "insert_after" or "delete"), html (the new paragraph(s) for replace and inserts; plain text becomes <p> paragraphs, a blank line separating them), ' +
    'and starts_with: the first words of that paragraph as you read it. Numbers refer to the chapter as it was before this call. ' +
    'An edit whose starts_with no longer matches (the paragraph moved or changed) is not applied — the others are — and you get that paragraph\'s current text. A list entry is a paragraph of its own and stays a list entry. ' +
    'For changes to most of a chapter, rewrite it instead.',
  parameters: {
    type: 'object',
    properties: {
      chapter: { type: 'string', description: 'The chapter\'s position in the CHAPTER INDEX (#n — never a number from its title), or its exact title (default: the active chapter).' },
      edits: {
        type: 'array',
        description: 'The changes, in any order.',
        items: {
          type: 'object',
          properties: {
            paragraph: { type: 'integer', description: 'The ¶ number, as grep or read showed it.' },
            action: { type: 'string', description: '"replace", "insert_before", "insert_after" or "delete".' },
            html: { type: 'string', description: 'The new paragraph(s): HTML blocks, or plain text. Not used by delete.' },
            starts_with: { type: 'string', description: 'The first few words of that paragraph as you read it.' }
          },
          required: ['paragraph', 'action', 'starts_with']
        }
      },
      plan_done: PLAN_DONE_PARAMETER
    },
    required: ['edits']
  },
  kind: 'write',
  isAvailable: () => true,
  parse: raw => {
    if (!raw) return 'its arguments could not be parsed'
    const list = Array.isArray(raw.edits) ? raw.edits : []
    if (list.length === 0) return 'no edits were given (pass "edits": [{paragraph, action, html, starts_with}])'
    const edits: ParagraphEdit[] = []
    for (const [i, item] of list.entries()) {
      const e = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const paragraph = paragraphNumber(e.paragraph)
      if (paragraph === null) return `edit ${i + 1} has no paragraph number`
      const action = String(e.action ?? '').trim().toLowerCase() as ParagraphAction
      if (!PARAGRAPH_ACTIONS.includes(action)) return `edit ${i + 1}: action must be one of ${PARAGRAPH_ACTIONS.join(', ')}`
      const startsWith = typeof e.starts_with === 'string' ? e.starts_with : typeof e.startsWith === 'string' ? e.startsWith : ''
      edits.push({ paragraph, action, startsWith, ...(typeof e.html === 'string' ? { html: e.html } : {}) })
    }
    return { chapter: chapterArg(raw), edits, planDone: planDoneArg(raw) }
  },
  execute: ({ chapter, edits, planDone }, ctx): ToolResult | Promise<ToolResult> => {
    if (isNewChapterRef(chapter)) return { ok: false, retryable: true, content: 'edit_paragraphs changes an existing chapter; write a new one with update_document.', trace: '⚠️ edit_paragraphs: not a new chapter' }
    const target = resolveTarget(chapter, ctx)
    if (typeof target === 'string') return { ok: false, retryable: true, content: target, trace: `⚠️ edit_paragraphs: ${target.split('\n')[0]}` }
    // The selection rewrite keeps its own diff in that chapter; edits beside
    // it go through edit_document, which places them around it.
    if (target.isStart && ctx.run.selectionAttempted) {
      return { ok: false, retryable: true, content: `${citeChapter(target)} has a selection rewrite in this turn; change other parts of it with edit_document.`, trace: '⚠️ edit_paragraphs: beside a selection rewrite' }
    }
    return then(withLoaded(ctx, target, (): ToolResult => {
      if (userEdited(ctx, target.id)) return editedMeanwhile(ctx, target)
      const st = docState(ctx, target)
      const outcome = applyParagraphEdits(st.html, edits.map(e => (e.html === undefined ? e : { ...e, html: ctx.images.restore(e.html) })))
      if (!outcome.ok) {
        return {
          ok: false,
          retryable: true,
          content: `edit_paragraphs on ${citeChapter(target)}: ${outcome.error}`,
          trace: `⚠️ edit_paragraphs on ${citeChapter(target)}: nothing applied${outcome.stale.length > 0 ? ` (${outcome.stale.length} anchor${outcome.stale.length === 1 ? '' : 's'} out of date)` : ''}`
        }
      }
      st.html = stripBlankParagraphs(outcome.html)
      st.dirty = true
      commitDoc(ctx, target, st)
      touch(ctx, target, 'edits', outcome.applied, 0)
      const shift = outcome.paragraphsAfter - outcome.paragraphsBefore
      const left = outcome.skipped.length
      return {
        // Some applied: a write landed. What was left out goes back to the model as a retry.
        ok: true,
        content: `Applied ${outcome.applied} paragraph edit(s) to ${citeChapter(target)}. It now has ${outcome.paragraphsAfter} paragraphs and ${chapterChars(st.html)} characters.` +
          (shift !== 0 ? ` Paragraphs after ¶${outcome.firstChanged} moved by ${shift > 0 ? '+' : ''}${shift}: take their new numbers from grep or a read before editing them again.` : '') +
          (left > 0 ? `\nNOT applied (${left}) — redo these with numbers and anchors from a fresh read:\n${outcome.skipped.join('\n')}` : ''),
        trace: `✏️ edited ${citeChapter(target)} by paragraph (${outcome.applied} change${outcome.applied === 1 ? '' : 's'}${left > 0 ? `; ${left} not applied` : ''})`
      }
    }), r => withPlanDone(ctx, r, planDone))
  }
})

// ── replace_text ────────────────────────────────────────────────────────────

/**
 * Find and replace across chapters, in their text only (utils/textReplace):
 * renaming a character in ten chapters is one call, not a read and an edit
 * per chapter (user request, 2026-10-12). No read first — the change is
 * mechanical, and the result reports the count and samples per chapter.
 * Each chapter it changes becomes one reviewable diff with a version
 * snapshot, like any other write. `expect` refuses the whole call when the
 * count differs (a short name inside longer words), `preview` only reports.
 */
export const replaceTextTool = defineTool<{ find: string; replace: string; chapters: unknown[] | 'all'; regex: boolean; expect: number | null; preview: boolean }>({
  name: 'replace_text',
  description:
    'Find and replace text across chapters in one call — renaming a character, a place, a term — in the text only, never in markup, links or images. No read is needed first. ' +
    'Each chapter changed becomes a change the user reviews. A short name can sit inside longer words (王 in 王小明): run it with preview first, or pass expect (the number of replacements you intend; if the count differs nothing is changed and you get the matches). ' +
    'For changes that need judgement occurrence by occurrence, use edit_paragraphs instead.',
  parameters: {
    type: 'object',
    properties: {
      find: { type: 'string', description: 'The text to find (exactly as it reads), or a regular expression when regex is true.' },
      replace: { type: 'string', description: 'The replacement text. With regex, $1, $2… insert groups and $& the whole match.' },
      chapters: { type: 'array', description: 'The chapters to change: positions from the CHAPTER INDEX or exact titles; ["all"] for every chapter.', items: { type: 'string' } },
      regex: { type: 'boolean', description: 'Optional: find is a regular expression (JavaScript syntax).' },
      expect: { type: 'integer', description: 'Optional: the total number of replacements you intend; a different count changes nothing.' },
      preview: { type: 'boolean', description: 'Optional: only list the matches; change nothing.' }
    },
    required: ['find', 'replace', 'chapters']
  },
  kind: 'write',
  isAvailable: () => true,
  parse: raw => {
    if (!raw) return 'its arguments could not be parsed'
    const find = typeof raw.find === 'string' ? raw.find : ''
    if (!find) return 'find was empty'
    if (typeof raw.replace !== 'string') return 'replace is required (an empty string deletes the text)'
    const list = Array.isArray(raw.chapters) ? raw.chapters : raw.chapters === undefined ? [] : [raw.chapters]
    if (list.length === 0) return 'no chapters were named (pass "chapters": ["3", "4"] or ["all"])'
    const all = list.some(c => typeof c === 'string' && c.trim().toLowerCase() === 'all')
    const expect = typeof raw.expect === 'number' && Number.isInteger(raw.expect) && raw.expect >= 0 ? raw.expect : null
    return { find, replace: raw.replace, chapters: all ? 'all' : list, regex: raw.regex === true || raw.regex === 'true', expect, preview: raw.preview === true || raw.preview === 'true' }
  },
  execute: async ({ find, replace, chapters, regex, expect, preview }, ctx): Promise<ToolResult> => {
    const book = ctx.document.chapters()
    const targets: Target[] = []
    const problems: string[] = []
    const refs: unknown[] = chapters === 'all' ? book.map((_, i) => i + 1) : chapters
    for (const ref of refs) {
      const t = resolveTarget(ref, ctx)
      if (typeof t === 'string') problems.push(t.split('\n')[0])
      else if (!targets.some(x => x.id === t.id)) targets.push(t)
    }
    if (targets.length === 0) return { ok: false, retryable: true, content: `replace_text: ${problems.join(' ') || 'no chapter matched'}`, trace: '⚠️ replace_text: no chapter' }
    await ctx.document.ensureLoaded(targets.filter(t => !t.isStart).map(t => t.id))

    const planned: Array<{ target: Target; html: string; count: number; samples: string[] }> = []
    const skipped: string[] = []
    for (const target of targets) {
      if (target.isStart && ctx.run.selectionAttempted) { skipped.push(`${citeChapter(target)}: it has a selection rewrite in this turn`); continue }
      if (ctx.document.chapters().find(c => c.id === target.id)?.loaded === false) { skipped.push(`${citeChapter(target)}: could not be loaded`); continue }
      if (userEdited(ctx, target.id)) { forgetChapter(ctx, target.id); skipped.push(`${citeChapter(target)}: the user changed it while you worked — read it again`); continue }
      const st = docState(ctx, target)
      const outcome = replaceInHtmlText(st.html, find, replace, regex)
      if (outcome.error) return { ok: false, retryable: true, content: `replace_text: ${outcome.error}. Nothing was changed.`, trace: `⚠️ replace_text: ${outcome.error}` }
      if (outcome.count > 0) planned.push({ target, html: outcome.html, count: outcome.count, samples: outcome.samples })
    }
    const total = planned.reduce((sum, p) => sum + p.count, 0)
    const report = planned.map(p => `${citeChapter(p.target)}: ${p.count}\n${p.samples.map(x => `  ${x}`).join('\n')}`).join('\n')
    const notes = [...problems, ...skipped].map(x => `Not searched — ${x}`).join('\n')
    const label = `${find.length > 20 ? `${find.slice(0, 20)}…` : find}→${replace.length > 20 ? `${replace.slice(0, 20)}…` : replace}`

    if (preview || (expect !== null && expect !== total)) {
      const why = preview ? 'Preview only: nothing was changed.' : `You expected ${expect} replacement(s); there are ${total}, so nothing was changed. Narrow find (or use regex), or pass the right expect.`
      return {
        ok: preview, retryable: !preview,
        content: `${why}\n${total} match(es) in ${planned.length} chapter(s)${report ? `:\n${report}` : '.'}${notes ? `\n${notes}` : ''}`,
        trace: preview ? `🔍 replace_text preview ${label}: ${total} in ${planned.length} chapter(s)` : `⚠️ replace_text ${label}: ${total} found, ${expect} expected — nothing changed`
      }
    }
    if (total === 0) {
      return { ok: false, retryable: true, content: `No "${find}" in the ${targets.length} chapter(s) searched; nothing was changed.${notes ? `\n${notes}` : ''}`, trace: `⚠️ replace_text ${label}: not found` }
    }
    for (const p of planned) {
      const st = docState(ctx, p.target)
      st.html = p.html
      st.dirty = true
      commitDoc(ctx, p.target, st)
      touch(ctx, p.target, 'edits', p.count, 0)
    }
    return {
      ok: true,
      content: `Replaced ${total} occurrence(s) in ${planned.length} chapter(s), each a change the user reviews:\n${report}${notes ? `\n${notes}` : ''}`,
      trace: `🔁 replaced ${label}: ${total} in ${planned.length} chapter${planned.length === 1 ? '' : 's'}${skipped.length + problems.length > 0 ? ` (${skipped.length + problems.length} not searched)` : ''}`
    }
  }
})

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
/**
 * A rename carries the chapter's leading <h1> along when it read the old
 * title — the same linkage as renaming in the editor's header
 * (`contentWithRenamedHeading`).
 *
 * Problem: renumbering the chapters after a deleted one took two calls per
 *   chapter — rename_chapter, then an edit of ¶1 — 30 calls for 15
 *   chapters (2026-10-11).
 * Fix: a heading that equals the old title follows the rename. Any other
 *   heading is the writer's, and stays (the result says what it reads). It
 *   is not a reviewable change, as the rename itself is not; a chapter the
 *   user changed meanwhile, or one whose heading has a pending diff, is left
 *   alone.
 *
 * The run's working copy of the chapter, if it has one, gets the same
 * heading, or its next write would put the old one back.
 */
function renameHeading(ctx: ToolContext, target: Target, title: string): boolean {
  if (userEdited(ctx, target.id)) return false
  const stored = storedContent(ctx, target.id)
  if (leadingH1Text(stored) !== target.title.trim()) return false
  const renamed = contentWithRenamedHeading(stored, title)
  if (renamed === null) return false
  const st = ctx.run.docs.get(target.id)
  if (st) {
    const follow = (html: string) => contentWithRenamedHeading(html, title) ?? html
    st.original = follow(st.original)
    st.base = follow(st.base)
    st.reviewBase = follow(st.reviewBase)
    st.html = follow(st.html)
    commitHtml(ctx, target.id, st.dirty ? diffHtml(st.reviewBase, st.html) : st.original)
  } else {
    commitHtml(ctx, target.id, renamed)
  }
  return true
}

export const renameChapterTool = defineTool<{ chapter: unknown; title: string; replace: boolean }>({
  name: 'rename_chapter',
  // Problem: replayed 2026-10-06, grok with no reasoning wanted to "create"
  //   a character-card chapter and called rename_chapter("人物卡" → "人物卡")
  //   twice in six tries — "you created a chapter" in this description read
  //   as creating — and twice renamed the user's chapters, unasked.
  // Fix: say what it is for and that it never adds a chapter; the replace
  //   case is described on its own parameter.
  description:
    'Rename an existing chapter. Rename only a chapter the user asked you to rename, or one you added in this turn. ' +
    'It never adds a chapter: a new chapter is added by writing it (new_chapter).',
  parameters: {
    type: 'object',
    properties: {
      chapter: { type: 'string', description: 'The chapter to rename: its number in the CHAPTER INDEX, or its exact title.' },
      title: { type: 'string', description: 'The new title.' },
      replace: { type: 'boolean', description: 'Only for a chapter you added in this turn, when another chapter already has this title because that is the one you meant to rewrite: true moves this chapter\'s text into it (in place, as a change the user reviews) and removes this chapter, so nothing is written again.' }
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
    if (typeof source === 'string') {
      // Most often a "create" in disguise (renaming "人物卡" to "人物卡"):
      // say what adds a chapter, not only which chapters exist.
      const write = ctx.run.writeProtocol === 'markup'
        ? `<canvas new_chapter="${title}">…</canvas>`
        : `update_document with new_chapter="${title}"`
      return {
        ok: false,
        retryable: true,
        content: `rename_chapter only renames a chapter that exists, and nothing was renamed. ${source}\n` +
          `To add a new chapter titled "${title}", write it: ${write}.`,
        trace: `⚠️ rename: ${source.split('\n')[0]}`
      }
    }
    const chapters = ctx.document.chapters()
    const holderIndex = chapters.findIndex(c => c.id !== source.id && titleKey(c.title) === titleKey(title))

    if (holderIndex === -1) {
      if (source.title === title) {
        return { ok: true, content: `${citeChapter(source)} already has that title.`, trace: `✏️ ${citeChapter(source)} already so titled` }
      }
      return withLoaded(ctx, source, () => {
        ctx.document.rename(source.id, title)
        touch(ctx, { ...source, title }, 'renamed', 0, 0)
        const headingMoved = renameHeading(ctx, source, title)
        const heading = leadingH1Text(storedContent(ctx, source.id))
        return {
          ok: true,
          content: `Renamed #${source.number} from "${source.title}" to "${title}".` +
            (headingMoved ? ' Its first heading, which read the old title, now reads the new one.'
              : heading && heading !== title ? ` Its first heading still reads "${heading}"; change it with an edit if it should match.` : ''),
          trace: `🏷 renamed #${source.number} "${source.title}" → "${title}"`
        }
      })
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
