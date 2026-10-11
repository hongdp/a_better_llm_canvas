/**
 * Reading and moving around the book: read_chapter, grep, list_chapters,
 * open_chapter, delete_chapter, and rename_chapter (defined with the writes it
 * shares state with) (spec §6, D6). There is no create_chapter: a
 * chapter is created by the write that fills it (documentWrites,
 * claimNewChapter).
 *
 * The model finds what it needs from the CHAPTER INDEX it is sent every turn
 * and reads it here — the user no longer attaches chapters by hand (D7).
 */
import { defineTool } from '../registry'
import { citeChapter, resolveChapter, type ResolvedChapter } from '../chapters'
import { chapterOutline, type ToolContext, type ToolResult } from '../types'
import { stripDiffMarkup } from '../../utils/diff'
import { htmlToPlainText } from '../../utils/llmContext'
import { hashContent } from '../../utils/contextLedger'
import { chapterParagraphs, isPlainChapterHtml, numberedLine } from '../../utils/paragraphs'
import { pendingChanges, renderPendingChanges } from '../../utils/pendingChanges'
import { forgetChapter, renameChapterTool, userEdited } from './documentWrites'
import { ATTACHMENT_RUN_READ_CAP, LIST_SECTION_LINES, attachmentBudgetNote, findAttachmentRange, renderAttachmentPart, renderSectionList, resolveAttachmentRef, type AttachmentMeta } from '../../utils/attachments'
import { isBlankContent } from '../../utils/text'
import { readForTask, restOfReadNote } from './analyzeBook'

/** Per chapter per call — the ledger's per-chapter cap (MAX_LEDGER_DOC_CHARS). */
export const READ_CHAPTER_CAP = 20_000
/** Per read_chapter call, across all the chapters it names. */
export const READ_CALL_CAP = 60_000
const SNIPPET_RADIUS = 60
const DEFAULT_SEARCH_RESULTS = 20
const MAX_SEARCH_RESULTS = 50

/** How to write a whole chapter, in the form this model uses. */
const fullWrite = (ctx: ToolContext, number: number) => ctx.run.writeProtocol === 'markup'
  ? `<canvas chapter="${number}">…</canvas>`
  : `update_document with chapter="${number}"`

const fail = (name: string, message: string): ToolResult => ({
  ok: false, retryable: true, content: message, trace: `${name}: ${message.split('\n')[0]}`
})

/**
 * A chapter's current accepted reading — what the model should see. The
 * run's own working copy wins: a chapter this run already changed is read
 * back as changed.
 */
export function acceptedHtml(ctx: ToolContext, id: string): string {
  const working = ctx.run.docs.get(id)
  if (working) return working.html
  return stripDiffMarkup(ctx.document.chapters().find(c => c.id === id)?.content ?? '')
}

const ATTACHMENT_REF_RE = /^\s*(?:A|附件)\s*\d+\s*$/i

export type ResolvedRef = { chapter: ResolvedChapter } | { attachment: AttachmentMeta } | { error: string }

/**
 * A chapter or an attachment (docs/features/attachments_and_web.md §1): "A1"
 * is an attachment; anything else a chapter first and an attachment's name
 * second.
 */
export function resolveRef(ref: unknown, chapters: Array<{ id: string; title: string }>, attachments: AttachmentMeta[]): ResolvedRef {
  if (attachments.length > 0 && ATTACHMENT_REF_RE.test(String(ref))) {
    const att = resolveAttachmentRef(ref, attachments)
    if (att) return { attachment: att }
  }
  const r = resolveChapter(ref, chapters)
  if (typeof r !== 'string') return { chapter: r }
  const att = attachments.length > 0 ? resolveAttachmentRef(ref, attachments) : null
  return att ? { attachment: att } : { error: r }
}

export const attachmentList = (ctx: ToolContext): AttachmentMeta[] => ctx.attachments?.list() ?? []

function chapterRefs(raw: Record<string, unknown>): unknown[] {
  if (Array.isArray(raw.chapters)) return raw.chapters
  if (raw.chapters !== undefined) return [raw.chapters]
  if (raw.chapter !== undefined) return [raw.chapter]
  return []
}

// ── read_chapter ────────────────────────────────────────────────────────────

/**
 * How many steps back a copy still counts as "right there": a read repeated
 * within this distance is refused as a duplicate, an older one is allowed.
 */
const RECENT_STEPS = 1

/** Paragraphs to read: 1-based and inclusive; `to` null = to the end. */
export interface ParagraphRange {
  from: number
  to: number | null
}

/**
 * "40-60", "45", "81-", "-15" (the first 15) or [40, 60]. A string error for
 * anything else, so the model learns the syntax instead of silently reading
 * the wrong part.
 */
/**
 * Several ranges at once — "1,8,10-12" — as read takes them: the model asked
 * for ten scattered paragraphs this way and was refused (run-d9e54ca576dc).
 * One range, or none, is a list of one.
 */
export function parseRanges(raw: unknown): Array<ParagraphRange | null> | string {
  const list = typeof raw === 'string' && /[,，、]/.test(raw) ? raw.split(/[,，、]/).map(p => p.trim()).filter(Boolean)
    : Array.isArray(raw) && raw.length > 2 ? raw
    : null
  if (!list) {
    const one = parseRange(raw)
    return typeof one === 'string' ? one : [one]
  }
  const out: Array<ParagraphRange | null> = []
  for (const part of list) {
    const r = parseRange(part)
    if (typeof r === 'string') return r
    out.push(r)
  }
  return out
}

export function parseRange(raw: unknown): ParagraphRange | null | string {
  if (raw === undefined || raw === null || raw === '') return null
  if (Array.isArray(raw) && raw.length >= 1 && raw.length <= 2 && raw.every(n => Number.isInteger(Number(n)))) {
    const [a, b] = raw.map(Number)
    return a >= 1 && (b === undefined || b >= a) ? { from: a, to: b ?? a } : `paragraph range ${JSON.stringify(raw)} is not valid`
  }
  // grok has sent the range quoted twice ("\"50-80\"") — the value is plain,
  // only its wrapping is wrong, so it is read rather than refused.
  const value = String(raw).trim().replace(/^["'“”「」]+|["'“”「」]+$/g, '')
  // "-15": grok asked for the opening paragraphs this way (2026-10-06) and
  // was refused; it means what a reader would take it to mean.
  const head = /^\s*(?:-|–|~)\s*¶?(\d+)\s*$/.exec(value)
  if (head) {
    const to = Number(head[1])
    return to >= 1 ? { from: 1, to } : `paragraph range ${JSON.stringify(raw)} is not valid`
  }
  const m = /^\s*¶?(\d+)\s*(?:(-|–|~)\s*¶?(\d+)?)?\s*$/.exec(value)
  if (!m) return `paragraphs must look like "40-60", "45", "81-" or "-15", not ${JSON.stringify(raw)}`
  const from = Number(m[1])
  const to = m[3] !== undefined ? Number(m[3]) : m[2] ? null : from
  if (from < 1 || (to !== null && to < from)) return `paragraph range ${JSON.stringify(raw)} is not valid`
  return { from, to }
}

/** One thing to read: a chapter, and optionally a paragraph range of it. */
interface ReadItem {
  ref: unknown
  range: ParagraphRange | null
  /** Attachments only: a section by its heading ("第三十章"). */
  section?: string
}

interface ReadArgs {
  items: ReadItem[]
  format: 'text' | 'html'
  /** What the notes are for, when what was asked for does not fit in one read (read_and_list.md §2). */
  task?: string
  /** The user agreed to a task-read past ANALYZE_CONFIRM_TOKENS. */
  confirmed: boolean
}

/** Parts one read call may name (agentic_chat_loop.md §0.11). */
export const MAX_READ_PARTS = 12

/**
 * Whether reading `items` fits in one call — per part, per call, and the
 * turn's attachment budget — measured without reading (no run state
 * changes). A bad reference counts as fitting: the read path reports it.
 */
async function fitsInOneRead(items: ReadItem[], format: 'text' | 'html', ctx: ToolContext): Promise<boolean> {
  const chapters = ctx.document.chapters()
  const attachments = attachmentList(ctx)
  let total = 0
  let attachmentTotal = 0
  const ids: string[] = []
  const resolved = items.map(item => ({ item, r: resolveRef(item.ref, chapters, attachments) }))
  for (const { r } of resolved) if ('chapter' in r) ids.push(r.chapter.id)
  await ctx.document.ensureLoaded([...new Set(ids)])
  for (const { item, r } of resolved) {
    let size = 0
    if ('chapter' in r) {
      const paras = chapterParagraphs(acceptedHtml(ctx, r.chapter.id))
      const from = item.range?.from ?? 1
      const to = Math.min(item.range?.to ?? paras.length, paras.length)
      for (const p of paras) if (p.number >= from && p.number <= to) size += (format === 'html' ? p.html.length : p.text.length + 6)
    } else if ('attachment' in r) {
      const paras = await (ctx.attachments as NonNullable<ToolContext['attachments']>).paragraphs(r.attachment.id)
      const span = item.section ? findAttachmentRange(r.attachment.sections, item.section) : null
      const from = span?.from ?? item.range?.from ?? 1
      const to = Math.min(span?.to ?? item.range?.to ?? paras.length, paras.length)
      for (let n = from; n <= to; n++) size += paras[n - 1].length + 6
      attachmentTotal += size
    }
    if (size > READ_CHAPTER_CAP) return false
    total += size
  }
  return total <= READ_CALL_CAP && attachmentTotal <= ATTACHMENT_RUN_READ_CAP - ctx.run.attachmentChars
}

export const readTool = defineTool<ReadArgs>({
  name: 'read',
  aliases: ['read_chapter', 'analyze_book'],
  description:
    'Read chapters of the book, or attachments. Find chapters in the CHAPTER INDEX and pass their numbers. ' +
    'Format "text" (default) returns numbered paragraphs ("¶12 …"), for reading content and consistency; ' +
    '"html" returns the chapter\'s HTML without numbers, for SEARCH edits — not needed for edit_paragraphs, nor to rewrite a chapter of plain paragraphs whose whole text you have seen. ' +
    'Pass paragraphs (e.g. "40-60", or "81-" for the rest) to read only part of a chapter — after grep found a ¶ number, read around it instead of the whole chapter. ' +
    `To look at several places at once, pass parts (up to ${MAX_READ_PARTS}), e.g. [{"chapter":"3","paragraphs":"10-16"},{"chapter":"8","paragraphs":"30-36"}]: one call, one step. ` +
    `A long chapter comes back in parts of at most ${READ_CHAPTER_CAP} characters, ending at a whole paragraph, with the range to continue from. ` +
    'If no title tells you where something is, use grep. ' +
    'Attachments (A1, A2… in ATTACHMENTS) are read the same way: chapters=["A1"] with a paragraph range (¶ numbers, which grep reports; in a novel .txt a ¶ is a line), or with section (a heading such as "第三十章" — 第30章 is the same chapter — or a run, "第62–87章"). ' +
    'A turn reads at most 100,000 characters of attachments. ' +
    'More than fits in one read (a long part, or many chapters): you get the first part, where to continue, and what reading the rest would cost. Pass task="what you need from it" to have all of it read in batches outside the conversation and get notes back — with no chapters named, the whole book. ' +
    'That costs a model call per batch; past 200,000 input tokens it is not started until you ask the user with ask_user and call again with confirmed: true. ' +
    'To see what can be read and where, use list.',
  parameters: {
    type: 'object',
    properties: {
      chapters: {
        type: 'array',
        description: 'Chapter numbers from the CHAPTER INDEX (or exact titles), or attachment references (A1).',
        items: { type: 'string' }
      },
      format: { type: 'string', description: '"text" (default, numbered paragraphs) or "html" (for SEARCH edits).' },
      paragraphs: { type: 'string', description: 'Optional paragraph range, e.g. "40-60", "45", "81-" (to the end) or "-15" (the first 15), or several: "1,8,10-12". Default: the whole chapter.' },
      section: { type: 'string', description: 'Attachments only: a section by its heading, e.g. "第三十章" (第30章 is the same chapter), or a run, "第62–87章".' },
      task: { type: 'string', description: 'Only when you need more than one read returns: what the notes are for, e.g. "list every promise 晓晓 makes and whether it is kept". When what you asked for fits, you get the text instead.' },
      confirmed: { type: 'boolean', description: 'true only after the user agreed to a task-read past 200,000 input tokens.' },
      parts: {
        type: 'array',
        description: 'Instead of chapters/paragraphs: several places to read in one call, each a chapter and an optional paragraph range.',
        items: {
          type: 'object',
          properties: {
            chapter: { type: 'string', description: 'A chapter number from the CHAPTER INDEX (or its exact title).' },
            paragraphs: { type: 'string', description: 'Optional range, as in paragraphs above.' },
            section: { type: 'string', description: 'Attachments only: a section by its heading.' }
          },
          required: ['chapter']
        }
      }
    }
  },
  kind: 'read',
  isAvailable: () => true,
  parse: raw => {
    if (!raw) return 'its arguments could not be parsed'
    const format = raw.format === 'html' ? 'html' : 'text'
    const task = typeof raw.task === 'string' && raw.task.trim() ? raw.task.trim() : undefined
    const extra = { ...(task ? { task } : {}), confirmed: raw.confirmed === true }
    if (Array.isArray(raw.parts) && raw.parts.length > 0) {
      if (raw.parts.length > MAX_READ_PARTS) return `at most ${MAX_READ_PARTS} parts in one call (${raw.parts.length} were given)`
      const items: ReadItem[] = []
      for (const [i, part] of raw.parts.entries()) {
        const p = part && typeof part === 'object' ? part as Record<string, unknown> : null
        const ref = p ? (p.chapter ?? (Array.isArray(p.chapters) ? p.chapters[0] : p.chapters)) : part
        if (ref === undefined || ref === null || ref === '') return `part ${i + 1} names no chapter`
        const ranges = parseRanges(p?.paragraphs)
        if (typeof ranges === 'string') return `part ${i + 1}: ${ranges}`
        const section = typeof p?.section === 'string' && p.section.trim() ? p.section : undefined
        for (const range of ranges) items.push({ ref, range, ...(section ? { section } : {}) })
      }
      if (items.length > MAX_READ_PARTS) return `at most ${MAX_READ_PARTS} parts in one call (${items.length} were given; each paragraph range counts)`
      return { items, format, ...extra }
    }
    const refs = chapterRefs(raw)
    if (refs.length === 0 && !task) return 'no chapter was named (pass "chapters": [numbers from the CHAPTER INDEX], or "parts"; or a task, to read the whole book for it)'
    const ranges = parseRanges(raw.paragraphs)
    if (typeof ranges === 'string') return ranges
    const section = typeof raw.section === 'string' && raw.section.trim() ? raw.section : undefined
    const items = refs.flatMap(ref => ranges.map(range => ({ ref, range, ...(section ? { section } : {}) })))
    if (items.length > MAX_READ_PARTS) return `at most ${MAX_READ_PARTS} parts in one call (${items.length} were given; each paragraph range counts)`
    return { items, format, ...extra }
  },
  execute: async ({ items, format, task, confirmed }, ctx): Promise<ToolResult> => {
    // More than one read returns, with a task: batches outside the conversation (read_and_list.md §2).
    if (task && (items.length === 0 || !(await fitsInOneRead(items, format, ctx)))) return readForTask(task, items, confirmed, ctx)
    const fits = task ? true : await fitsInOneRead(items, format, ctx)
    const result = await readItems(items, format, ctx)
    // Cut short with no task: say what reading all of it would cost, before anything is spent.
    if (!fits) {
      const note = await restOfReadNote(items, ctx)
      if (note) return { ...result, content: `${result.content}

${note}` }
    }
    return result
  }
})

/** Kept for callers and tests that know the old name. */
export const readChapterTool = readTool

/** The text of `items`, as one call returns it: numbered paragraphs (or HTML), capped, with where to continue. */
async function readItems(items: ReadItem[], format: 'text' | 'html', ctx: ToolContext): Promise<ToolResult> {
  const chapters = ctx.document.chapters()
  const attachments = attachmentList(ctx)
  type Entry = ({ chapter: ResolvedChapter } | { attachment: AttachmentMeta }) & { key: string; range: ParagraphRange | null; section?: string }
  const resolved: Entry[] = []
  const errors: string[] = []
  for (const item of items) {
    const r = resolveRef(item.ref, chapters, attachments)
    if ('error' in r) { errors.push(r.error); continue }
    if (item.section && !('attachment' in r)) { errors.push(`section="${item.section}" names a part of an attachment; for a chapter, pass paragraphs instead.`); continue }
    const key = 'attachment' in r ? `a:${r.attachment.id}` : `c:${r.chapter.id}`
    if (!resolved.some(x => x.key === key && JSON.stringify(x.range) === JSON.stringify(item.range) && x.section === item.section)) {
      resolved.push({ ...r, key, range: item.range, ...(item.section ? { section: item.section } : {}) })
    }
  }
  if (resolved.length === 0) return fail('read', errors.join('\n'))

  await ctx.document.ensureLoaded([...new Set(resolved.flatMap(x => ('chapter' in x ? [x.chapter.id] : [])))])

  const parts: string[] = []
  const traces: string[] = []
  let budget = READ_CALL_CAP
  const skipped: string[] = []
  for (const entry of resolved) {
    let range = entry.range
    if ('attachment' in entry) {
      // A reference file: text only, never written (attachments_and_web.md §1).
      const att = entry.attachment
      const paras = await (ctx.attachments as NonNullable<ToolContext['attachments']>).paragraphs(att.id)
      if (entry.section) {
        // A section by its heading: "第三十章" and "第30章" are the same chapter.
        const sec = findAttachmentRange(att.sections, entry.section)
        if (!sec) {
          const sample = att.sections.slice(0, 6).map(s => `"${s.title}"`).join(', ')
          errors.push(`${att.ref} "${att.name}" has no section matching "${entry.section}".` +
            (sample ? ` Its sections begin ${sample}…; grep chapters=["${att.ref}"] for a heading.` : ' It has no section headings; grep it instead.'))
          continue
        }
        range = { from: sec.from, to: sec.to }
      }
      const start = range?.from ?? 1
      if (start > paras.length) { errors.push(`${att.ref} "${att.name}" has ${paras.length} paragraphs; there is no ¶${start}.`); continue }
      // Never the whole file: the turn's reads of attachments are capped (§1, user requirement).
      const left = ATTACHMENT_RUN_READ_CAP - ctx.run.attachmentChars
      if (left <= 0) { errors.push(attachmentBudgetNote(att.ref, ctx.run.attachmentChars)); continue }
      if (budget <= 0) { skipped.push(`${att.ref}${range ? ` ¶${start}` : ''}`); continue }
      const out = renderAttachmentPart(att, paras, start, range?.to ?? null, Math.min(READ_CHAPTER_CAP, budget, left))
      if (out.last < start) {
        // Not even its first paragraph fits in what the turn has left.
        errors.push(attachmentBudgetNote(att.ref, ctx.run.attachmentChars))
        continue
      }
      budget -= out.used
      ctx.run.attachmentChars += out.used
      parts.push(out.content)
      traces.push(`${att.ref} "${att.name}" ¶${start}–${out.last} (${(out.used / 1000).toFixed(1)}k, attachment)`)
      continue
    }
    const chapter = entry.chapter
    // The user changed it while the run worked: the run's copy is stale,
    // so read what is stored now.
    if (userEdited(ctx, chapter.id)) forgetChapter(ctx, chapter.id)
    const html = acceptedHtml(ctx, chapter.id)
    const paras = chapterParagraphs(html)
    const totalChars = paras.reduce((sum, p) => sum + p.text.length, 0)

    // Already in this request in full: say so instead of sending it twice —
    // in the first two steps, while that copy is still near. Later in a
    // long turn the model may want it in view again before writing
    // (user decision 2026-10-06: whether to re-read is the model's call).
    if (format === 'text' && !range && ctx.run.inContext.has(chapter.id) && !ctx.run.docs.has(chapter.id) && ctx.run.step <= RECENT_STEPS) {
      parts.push(`=== ${citeChapter(chapter)} is already in your context in full (it is the active chapter or in REFERENCED CHAPTERS). ===`)
      traces.push(`${citeChapter(chapter)} (already in context)`)
      continue
    }
    const from = range?.from ?? 1
    const to = Math.min(range?.to ?? paras.length, paras.length)
    if (from > paras.length) {
      errors.push(`${citeChapter(chapter)} has ${paras.length} paragraphs; there is no ¶${from}.`)
      continue
    }
    // The duplicate guard (D5): the same request for the same bytes, in this
    // step or the one before — the copy is right there. An older one may
    // be read again: in a long series it sits far behind the chapters
    // written since, and refreshing it is the model's call.
    const key = `${chapter.id}|${format}|${from}-${to}|${hashContent(html)}`
    const earlier = ctx.run.reads.get(key)
    if (earlier !== undefined && ctx.run.step - earlier <= RECENT_STEPS) {
      parts.push(`=== ${citeChapter(chapter)} ¶${from}–¶${to} was already returned in step ${earlier + 1} of this turn and has not changed since. ===`)
      traces.push(`${citeChapter(chapter)} (repeat)`)
      continue
    }
    if (budget <= 0) {
      skipped.push(`${citeChapter(chapter)}${range ? ` ¶${from}–${to}` : ''}`)
      continue
    }

    // Whole paragraphs only, up to the caps: a part never ends mid-paragraph.
    const cap = Math.min(READ_CHAPTER_CAP, budget)
    const lines: string[] = []
    let used = 0
    let last = from - 1
    for (const p of paras.slice(from - 1, to)) {
      const line = format === 'html' ? ctx.images.preserve(p.html) : numberedLine(p)
      if (lines.length > 0 && used + line.length > cap) break
      lines.push(line)
      used += line.length
      last = p.number
    }
    budget -= used
    const whole = from === 1 && last === paras.length
    // The part's own size, counted the way the chapter total is: a model
    // planning a rewrite "at least as long as the source" cannot count it
    // itself, and an estimate is not worth writing into an outline.
    const partChars = paras.slice(from - 1, last).reduce((sum, p) => sum + p.text.length, 0)
    const span = whole ? '' : `, ¶${from}–¶${last} of ${paras.length} (${partChars} characters)`
    const more = last < to
      ? `\n[Stopped at ¶${last} to stay under ${cap} characters. Continue with chapters=[${chapter.number}], paragraphs="${last + 1}-${range?.to ?? ''}", format="${format}".]`
      : ''
    // What its unaccepted changes replaced, so "keep what it said before"
    // can be done exactly (utils/pendingChanges).
    const stored = ctx.document.chapters().find(c => c.id === chapter.id)?.content ?? ''
    const pending = renderPendingChanges(pendingChanges(stored))
    /*
     * A text read hides formatting. A model that read a card as text wrote it
     * whole, was refused for not having seen its HTML, read it and wrote it
     * again — a minute of output thrown away (run-d9e54ca576dc). Say so here.
     */
    const formatted = format === 'text' && !isPlainChapterHtml(html)
      ? `\n[This chapter has formatting a text read does not show (lists, emphasis, images…): to rewrite it whole, read it with format="html" first; edit_paragraphs works from these ¶ numbers.]`
      : ''
    parts.push(`=== ${citeChapter(chapter)} — ${paras.length} paragraphs, ${totalChars} characters${span}, ${format} ===\n${lines.join('\n')}${more}${pending ? `\n\n${pending}` : ''}${formatted}`)
    traces.push(`${citeChapter(chapter)}${whole ? '' : ` ¶${from}–${last}`} (${(used / 1000).toFixed(1)}k, ${format})`)

    ctx.run.reads.set(key, ctx.run.step)
    ctx.run.readIds.add(chapter.id)
    // The whole current text, seen: enough to rewrite a plain chapter (§0.11).
    if (whole) ctx.run.textSeen.set(chapter.id, hashContent(html))
    if (format === 'html') {
      ctx.run.htmlShown.add(chapter.id)
      if (!ctx.run.known.has(chapter.id)) ctx.run.known.set(chapter.id, stored)
    }
  }
  if (skipped.length > 0) {
    parts.push(`[Not returned — this call reached its ${READ_CALL_CAP}-character limit: ${skipped.join(', ')}. Ask for them in another call.]`)
  }
  if (errors.length > 0) parts.push(errors.join('\n'))

  return {
    ok: errors.length === 0,
    // Some chapters were read; a bad reference beside them is worth a retry
    // only if nothing else came back.
    retryable: errors.length > 0 && traces.length === 0,
    content: parts.join('\n\n'),
    trace: `📖 read ${traces.join(', ')}`
  }
}

// ── grep ────────────────────────────────────────────────────────────────────

const DEFAULT_CONTEXT = SNIPPET_RADIUS
const MAX_CONTEXT = 300

/** The pattern as a regex; a pattern that is not one is searched literally. */
function compilePattern(pattern: string): { re: RegExp; literal: boolean } {
  try {
    return { re: new RegExp(pattern, 'gi'), literal: false }
  } catch {
    return { re: new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), literal: true }
  }
}

interface GrepArgs {
  patterns: string[]
  refs: unknown[]
  output: 'snippets' | 'chapters'
  context: number
  maxResults: number
}

/** Patterns one grep call may search (agentic_chat_loop.md §0.11). */
export const MAX_GREP_PATTERNS = 10

type ScopedChapter = ReturnType<ToolContext['document']['chapters']>[number] & { number: number }

/** One pattern over the chapters in scope: the head line, the snippet or per-chapter lines, and the totals. */
function searchPattern(pattern: string, scope: ScopedChapter[], ctx: ToolContext, output: GrepArgs['output'], context: number, maxResults: number, scoped: boolean,
  attached: Array<[AttachmentMeta, string[]]> = []) {
  const { re, literal } = compilePattern(pattern)
  const hits: string[] = []
  const perChapter: string[] = []
  let total = 0
  for (const [att, paras] of attached) {
    // A reference file named in `chapters` (attachments_and_web.md §1); never searched otherwise.
    const label = `${att.ref} "${att.name}"`
    let count = 0
    paras.forEach((text, i) => {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue }
        count++
        if (output === 'snippets' && hits.length < maxResults) {
          const from = Math.max(0, m.index - context)
          const to = Math.min(text.length, m.index + m[0].length + context)
          hits.push(`${label} ¶${i + 1}: ${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`)
        }
      }
    })
    if (count > 0) {
      perChapter.push(`${label} — ${count} match${count === 1 ? '' : 'es'}`)
      total += count
    }
  }
  for (const chapter of scope) {
    let count = 0
    // Paragraph by paragraph, so every hit carries the ¶ number that
    // read_chapter takes as a range — grep, then read around the hit.
    for (const para of chapterParagraphs(acceptedHtml(ctx, chapter.id))) {
      const text = para.text
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue }
        count++
        if (output === 'snippets' && hits.length < maxResults) {
          const from = Math.max(0, m.index - context)
          const to = Math.min(text.length, m.index + m[0].length + context)
          const snippet = text.slice(from, to).replace(/\s+/g, ' ')
          hits.push(`#${chapter.number} "${chapter.title}" ¶${para.number}: ${from > 0 ? '…' : ''}${snippet}${to < text.length ? '…' : ''}`)
        }
      }
    }
    // Only a non-empty match counts: `x*` matches everything at width zero.
    const titleHit = [...chapter.title.matchAll(re)].some(t => t[0].length > 0)
    re.lastIndex = 0
    if (count === 0 && titleHit) {
      if (output === 'snippets' && hits.length < maxResults) hits.push(`#${chapter.number} "${chapter.title}" (title matches)`)
      perChapter.push(`#${chapter.number} "${chapter.title}" — title matches`)
      total++
    } else if (count > 0) {
      perChapter.push(`#${chapter.number} "${chapter.title}" — ${count} match${count === 1 ? '' : 'es'}`)
      total += count
    }
  }
  const scopeNote = scoped ? ` in ${scope.length + attached.length} chapter(s)` : ''
  const literalNote = literal ? ' (not a valid regular expression; searched as plain text)' : ''
  const head = total === 0
    ? `No matches for /${pattern}/${scopeNote}${literalNote}.`
    : `${total} match(es) in ${perChapter.length} chapter(s)${scopeNote}${literalNote}` +
      (output === 'snippets' && total > hits.length ? `; showing the first ${hits.length}` : '') + ':'
  return { head, lines: output === 'chapters' ? perChapter : hits, total, chapterCount: perChapter.length }
}

/**
 * Find where something appears across the book — a regex search over every
 * chapter's text, the way a coding agent greps a repository. Named and shaped
 * like grep on purpose: it is the search interface models already know (the
 * same reason the document tools use the function-call format, utils/
 * documentTools). The model locates with it, then reads what it found.
 */
export const grepTool = defineTool<GrepArgs>({
  name: 'grep',
  description:
    'Search the book like grep: a regular expression (case-insensitive) over every chapter\'s text, or only the chapters you name. ' +
    'Use it to locate where a name, phrase, object or event appears before reading — e.g. "阿青|阿红", "第[一二三]次", "outline". ' +
    `To check several things at once, pass patterns (up to ${MAX_GREP_PATTERNS}): each is searched and reported on its own — one call, one step. ` +
    'output "snippets" (default) returns each match with its chapter number, paragraph number (¶) and surrounding text — read around it with read paragraphs="…", or change it with edit_paragraphs; output "chapters" returns only the chapters that match, with counts. ' +
    'Chapter titles are searched too. An attachment (A1…) is searched only when named in chapters.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'A JavaScript regular expression, matched case-insensitively. Plain words work as they are.' },
      patterns: { type: 'array', description: `Instead of pattern: up to ${MAX_GREP_PATTERNS} expressions, each searched and reported separately.`, items: { type: 'string' } },
      chapters: { type: 'array', description: 'Optional: limit the search to these chapters (numbers from the CHAPTER INDEX, or titles), or search attachments (A1).', items: { type: 'string' } },
      output: { type: 'string', description: '"snippets" (default) or "chapters".' },
      context: { type: 'integer', description: `Characters of text on each side of a match in snippets. Default ${DEFAULT_CONTEXT}, at most ${MAX_CONTEXT}.` },
      max_results: { type: 'integer', description: `Snippets to return per pattern. Default ${DEFAULT_SEARCH_RESULTS}, at most ${MAX_SEARCH_RESULTS}.` }
    }
  },
  kind: 'read',
  isAvailable: () => true,
  parse: raw => {
    const listed = Array.isArray(raw?.patterns) ? raw.patterns.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : []
    const single = typeof raw?.pattern === 'string' ? raw.pattern : typeof raw?.query === 'string' ? raw.query : ''
    const patterns = [...new Set(listed.length > 0 ? listed : single.trim() ? [single] : [])]
    if (patterns.length === 0) return 'the pattern was empty'
    if (patterns.length > MAX_GREP_PATTERNS) return `at most ${MAX_GREP_PATTERNS} patterns in one call (${patterns.length} were given)`
    const num = (v: unknown, fallback: number, max: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : fallback
    return {
      patterns,
      refs: raw ? chapterRefs(raw) : [],
      output: raw?.output === 'chapters' ? 'chapters' : 'snippets',
      context: num(raw?.context, DEFAULT_CONTEXT, MAX_CONTEXT),
      maxResults: Math.max(1, num(raw?.max_results, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS))
    }
  },
  execute: async ({ patterns, refs, output, context, maxResults }, ctx): Promise<ToolResult> => {
    const all = ctx.document.chapters()
    let scope: ScopedChapter[] = all.map((c, i) => ({ ...c, number: i + 1 }))
    const attachmentsScope: AttachmentMeta[] = []
    if (refs.length > 0) {
      const picked: ScopedChapter[] = []
      const known = attachmentList(ctx)
      for (const ref of refs) {
        const r = resolveRef(ref, all, known)
        if ('error' in r) return fail('grep', r.error)
        if ('attachment' in r) {
          if (!attachmentsScope.some(a => a.id === r.attachment.id)) attachmentsScope.push(r.attachment)
        } else if (!picked.some(c => c.id === r.chapter.id)) picked.push(scope[r.chapter.number - 1])
      }
      scope = picked
    }
    await ctx.document.ensureLoaded(scope.map(c => c.id))
    const attached: Array<[AttachmentMeta, string[]]> = []
    for (const a of attachmentsScope) attached.push([a, await (ctx.attachments as NonNullable<ToolContext['attachments']>).paragraphs(a.id)])
    // A server chapter whose text failed to load reads as '': searching it
    // would report "no match" for text that is there. Say it was skipped.
    const loadedNow = ctx.document.chapters()
    const unloaded = scope.filter(c => loadedNow.find(n => n.id === c.id)?.loaded === false)
    const searchable = scope.filter(c => !unloaded.includes(c))
    const results = patterns.map(p => ({ pattern: p, ...searchPattern(p, searchable, ctx, output, context, maxResults, refs.length > 0, attached) }))

    const skipped = unloaded.length > 0
      ? [`Not searched — their text could not be loaded: ${unloaded.map(c => `#${c.number} "${c.title}"`).join(', ')}.`]
      : []
    /*
     * The trace names what was searched. It used to read "→ 30 in 1
     * chapter(s)" whether the model had searched the whole book or named
     * one chapter, which read as "grep only searches one chapter" (user
     * question, 2026-10-06 — the model had in fact limited it to #13).
     */
    const labels = [...scope.map(c => `#${c.number}`), ...attached.map(([a]) => a.ref)]
    const where = refs.length === 0 ? 'in the whole book'
      : labels.length <= 4 ? `in ${labels.join(', ')}`
      : `in ${labels.length} chapters`
    if (results.length === 1) {
      const [r] = results
      const across = r.chapterCount > 1 || (refs.length === 0 && r.chapterCount > 0) ? ` in ${r.chapterCount} chapter(s)` : ''
      return {
        ok: true,
        content: [r.head, ...r.lines, ...skipped].join('\n'),
        trace: `🔎 grep /${r.pattern}/ ${where} → ${r.total} match${r.total === 1 ? '' : 'es'}${across}` +
          (unloaded.length > 0 ? ` · ${unloaded.length} not loaded` : '')
      }
    }
    const total = results.reduce((sum, r) => sum + r.total, 0)
    return {
      ok: true,
      content: [...results.map(r => [`=== /${r.pattern}/ ===`, r.head, ...r.lines].join('\n')), ...skipped].join('\n\n'),
      trace: `🔎 grep ${results.length} patterns ${where} → ${results.map(r => `/${r.pattern}/ ${r.total}`).join(', ')} (${total} in all)` +
        (unloaded.length > 0 ? ` · ${unloaded.length} not loaded` : '')
    }
  }
})

// ── list_chapters ───────────────────────────────────────────────────────────

interface ListArgs {
  source?: unknown
  section?: string
  range: ParagraphRange | null
  from: number
}

/**
 * What can be read, and where (read_and_list.md §3): every chapter and
 * attachment; an attachment's sections with their ¶ spans; a chapter's
 * headings. Replaces list_chapters, which listed chapters only — an
 * 879-chapter attachment showed 80 headings in the request and the model
 * grepped for the rest three steps in a row (run-737f3d809b45).
 */
export const listTool = defineTool<ListArgs>({
  name: 'list',
  aliases: ['list_chapters'],
  description:
    // Problem: "call this only after creating chapters" read, once creating
    //   became writing, as a step of creating one. grok announced a new
    //   chapter and called this 13 times instead of writing it (2026-10-06).
    'What can be read, and where. With no arguments: every chapter with its number and size, then each attachment (A1…) with its size and number of sections. ' +
    'The CHAPTER INDEX and ATTACHMENTS in the request already have this as of the start of the turn; call it when chapters were added, removed or renamed during the turn, or when you need sizes. ' +
    `source="A1": that attachment's sections, each with its ¶ span (${LIST_SECTION_LINES} per call, continue with from=), to read one by those numbers next; narrow it with section="第60–90章" or paragraphs. ` +
    'source="3": a chapter\'s headings with their ¶ numbers. ' +
    'It changes nothing in the book: a new chapter is added by writing it (new_chapter).',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Optional: an attachment (A1) or a chapter (its number) to list the parts of.' },
      section: { type: 'string', description: 'With an attachment: only the sections in this run, e.g. "第60–90章".' },
      paragraphs: { type: 'string', description: 'With an attachment: only the sections overlapping this ¶ range, e.g. "1200-3000".' },
      from: { type: 'integer', description: 'With an attachment: the section number to start from (to continue a long list).' }
    }
  },
  kind: 'read',
  isAvailable: () => true,
  parse: raw => {
    const range = parseRange(raw?.paragraphs)
    if (typeof range === 'string') return range
    const source = raw?.source ?? raw?.chapter
    const section = typeof raw?.section === 'string' && raw.section.trim() ? raw.section.trim() : undefined
    const from = typeof raw?.from === 'number' && Number.isFinite(raw.from) ? Math.max(1, Math.floor(raw.from)) : 1
    return { ...(source !== undefined && source !== null && source !== '' ? { source } : {}), ...(section ? { section } : {}), range, from }
  },
  execute: async ({ source, section, range, from }, ctx): Promise<ToolResult> => {
    if (source !== undefined) {
      const r = resolveRef(source, ctx.document.chapters(), attachmentList(ctx))
      if ('error' in r) return fail('list', r.error)
      if ('attachment' in r) {
        const att = r.attachment
        let sections = att.sections
        let args = ''
        if (range) {
          const to = range.to ?? att.paragraphs
          sections = sections.filter(s => s.to >= range.from && s.from <= to)
          args = ` paragraphs="${range.from}-${range.to ?? ''}"`
        } else if (section) {
          const span = findAttachmentRange(att.sections, section)
          if (!span) return fail('list', `${att.ref} has no section matching "${section}".`)
          sections = sections.filter(s => s.to >= span.from && s.from <= span.to)
          args = ` section="${section}"`
        }
        const first = Math.min(from, Math.max(1, sections.length))
        const last = Math.min(sections.length, first - 1 + LIST_SECTION_LINES)
        return {
          ok: true,
          content: renderSectionList(att, sections, from, LIST_SECTION_LINES, args),
          trace: sections.length > 0 ? `📚 list ${att.ref} sections ${first}–${last} of ${sections.length}` : `📚 list ${att.ref} (no sections)`
        }
      }
      const chapter = r.chapter
      await ctx.document.ensureLoaded([chapter.id])
      const paras = chapterParagraphs(acceptedHtml(ctx, chapter.id))
      const heads = paras.filter(p => p.kind === 'heading')
      return {
        ok: true,
        content: heads.length > 0
          ? `=== ${citeChapter(chapter)} — ${paras.length} paragraphs ===\n${heads.map(p => `¶${p.number} # ${p.text}`).join('\n')}`
          : `${citeChapter(chapter)} has no headings: ${paras.length} paragraphs. Read a range by ¶, or grep it.`,
        trace: `📚 list ${citeChapter(chapter)} headings`
      }
    }
    const lines = ctx.document.chapters().map((c, i) => {
      const html = acceptedHtml(ctx, c.id)
      const chars = htmlToPlainText(html).length
      const paras = chapterParagraphs(html).length
      const marks = [
        c.id === ctx.document.openId() ? 'open in the editor' : '',
        ctx.run.created.has(c.id) ? 'created this turn' : '',
        ctx.run.touched.has(c.id) ? 'changed this turn' : ''
      ].filter(Boolean)
      return `${i + 1}. "${c.title}" (${paras} paragraphs, ${chars} chars${marks.length ? `; ${marks.join('; ')}` : ''})`
    })
    const list = lines.join('\n')
    /*
     * Problem: the list was right and told the model nothing. grok announced
     *   "人物卡单独成章" and called this 13 times (2026-10-06), getting the
     *   same nine lines every time — the CHAPTER INDEX it already had, plus
     *   sizes — with nothing saying that no chapter had been added, or that
     *   none would be until it wrote one.
     * Fix: say what the list means for the turn: whether anything changed
     *   since it began, and since the last list.
     */
    const notes: string[] = []
    if (ctx.run.lastList === list) notes.push('This is identical to your previous list result: nothing has changed since then.')
    if (ctx.run.startOutline !== undefined && ctx.run.startOutline === chapterOutline(ctx.document.chapters())) {
      const write = ctx.run.writeProtocol === 'markup'
        ? '<canvas new_chapter="its title">…</canvas>'
        : 'update_document with new_chapter'
      notes.push(`No chapter has been added, removed or renamed in this turn: this is the CHAPTER INDEX of your request, with sizes. ` +
        `Listing changes nothing in the book. A new chapter appears here only after you write it, with ${write}.`)
    }
    ctx.run.lastList = list
    const atts = attachmentList(ctx)
    const files = atts.length === 0 ? '' : '\n\nATTACHMENTS (read them like chapters; list source="A1" shows a file\'s sections):\n' +
      atts.map(a => `${a.ref} "${a.name}" — ${a.chars} characters, ${a.paragraphs} paragraphs, ${a.sections.length} sections`).join('\n')
    return { ok: true, content: (notes.length > 0 ? `${list}\n\n${notes.join('\n')}` : list) + files, trace: atts.length > 0 ? `📚 list chapters and ${atts.length} attachment${atts.length === 1 ? '' : 's'}` : '📚 list chapters' }
  }
})

/** Kept for callers and tests that know the old name. */
export const listChaptersTool = listTool

// ── open_chapter ────────────────────────────────────────────────────────────

export const openChapterTool = defineTool<{ chapter: unknown }>({
  name: 'open_chapter',
  description:
    'ONLY to show a chapter to the user, when they ask to see it. Never call it to prepare a write or a read: every write names its chapter directly (`chapter`), and read_chapter reads any chapter. Opening a chapter changes nothing you can write or read.',
  parameters: {
    type: 'object',
    properties: { chapter: { type: 'string', description: 'Its number in the CHAPTER INDEX, or its exact title.' } },
    required: ['chapter']
  },
  kind: 'navigate',
  isAvailable: () => true,
  parse: raw => (raw && raw.chapter !== undefined ? { chapter: raw.chapter } : 'no chapter was named'),
  execute: ({ chapter }, ctx): ToolResult => {
    const target = resolveChapter(chapter, ctx.document.chapters())
    if (typeof target === 'string') return fail('open_chapter', target)
    // The user's selection belongs to the chapter that is open; leaving it
    // before the selection rewrite lands would strand that rewrite.
    if (ctx.selection.range() !== null && !ctx.run.selectionApplied && target.id !== ctx.document.openId()) {
      return {
        ok: false,
        retryable: false,
        content: 'The user has text selected in the open chapter; finish with the selection before showing another chapter.',
        trace: `open ${citeChapter(target)}: refused (selection pending)`
      }
    }
    if (target.id === ctx.document.openId()) {
      return { ok: true, content: `${citeChapter(target)} is already open.`, trace: `📂 ${citeChapter(target)} already open` }
    }
    // The user went to another chapter during this turn and may be typing
    // there; the view is theirs now.
    if (ctx.document.userMoved()) {
      return {
        ok: true,
        content: `${citeChapter(target)} was NOT opened: the user is working in another chapter. Tell them it is #${target.number} in the chapter list. Writing and reading it need no opening.`,
        trace: `📂 left ${citeChapter(target)} for the user to open`
      }
    }
    ctx.document.open(target.id)
    // Problem: this used to end with "read it with format html before editing
    //   it". Measured on a real turn: the model opened the chapter, opened it
    //   again, and only then rewrote it — two extra steps of 20–60 s each. A
    //   full rewrite needs no read at all.
    // Fix: say what each kind of write needs, nothing more.
    return {
      ok: true,
      content: `${citeChapter(target)} is now open in the editor for the user to see. ` +
        `To rewrite it whole, write it now: ${fullWrite(ctx, target.number)}.` +
        (ctx.run.htmlShown.has(target.id) ? '' : ' Only edits to parts of it need its HTML first (read, format "html").'),
      trace: `📂 open ${citeChapter(target)}`
    }
  }
})

// ── delete_chapter ──────────────────────────────────────────────────────────

/**
 * Delete a chapter nothing would be lost from: one this run created (by
 * mistake — grok once created an empty "skip" chapter, 2026-10-06)
 * or an empty one. A chapter with text is the user's to delete; the loop has
 * no way yet to ask for their confirmation (spec §6, `approval`), so it says
 * so instead.
 */
export const deleteChapterTool = defineTool<{ chapter: unknown }>({
  name: 'delete_chapter',
  description:
    'Delete a chapter you created by mistake, or an empty chapter. A chapter that has text can only be deleted by the user — ask them with ask_user; never empty a chapter to get around this. ' +
    'Deleting renumbers the chapters after it.',
  parameters: {
    type: 'object',
    properties: { chapter: { type: 'string', description: 'Its number in the CHAPTER INDEX, or its exact title.' } },
    required: ['chapter']
  },
  kind: 'write',
  // After every other call of the reply: they were numbered from the index
  // as it was before this deletion.
  runLast: true,
  isAvailable: () => true,
  parse: raw => (raw && raw.chapter !== undefined ? { chapter: raw.chapter } : 'no chapter was named'),
  execute: async ({ chapter }, ctx): Promise<ToolResult> => {
    const chapters = ctx.document.chapters()
    const target = resolveChapter(chapter, chapters)
    if (typeof target === 'string') return fail('delete_chapter', target)
    const refuse = (content: string, why: string): ToolResult =>
      ({ ok: false, retryable: false, content, trace: `🗑 delete ${citeChapter(target)} refused — ${why}` })
    if (target.id === ctx.document.startId) {
      return refuse(`${citeChapter(target)} is the chapter this turn started on; it cannot be deleted during the turn.`, 'the turn started there')
    }
    if (chapters.length <= 1) return refuse('It is the only chapter of the book.', 'the only chapter')
    // Created this run and untouched by the user since: the run's own.
    const own = ctx.run.created.has(target.id) && !userEdited(ctx, target.id)
    if (!own) {
      await ctx.document.ensureLoaded([target.id])
      const now = ctx.document.chapters().find(c => c.id === target.id)
      // A server chapter whose text has not arrived reads as '' — that is
      // not "empty", and deleting it would lose the text.
      if (!now || now.loaded === false) {
        return refuse(`${citeChapter(target)} could not be loaded, so it is not known to be empty. It was not deleted.`, 'not loaded')
      }
      if (!isBlankContent(now.content)) {
        return refuse(`${citeChapter(target)} has text. Only the user can delete a chapter with text: ask them with ask_user whether to, and tell them it is #${target.number} in the chapter list.`, 'it has text')
      }
    }
    ctx.document.remove(target.id)
    forgetChapter(ctx, target.id)
    ctx.run.created.delete(target.id)
    ctx.run.inContext.delete(target.id)
    // Gone: no "changed this turn" row pointing at it.
    ctx.run.touched.delete(target.id)
    const after = chapters.length - target.number
    return {
      ok: true,
      content: `Deleted ${citeChapter(target)}.` + (after > 0
        ? ` The ${after} chapter(s) after it moved up by one: #${target.number + 1} is now #${target.number}, and so on. The CHAPTER INDEX in your request still shows the old numbers.`
        : ''),
      trace: `🗑 deleted ${citeChapter(target)}`
    }
  }
})

export const BOOK_TOOLS = [readTool, grepTool, listTool, openChapterTool, deleteChapterTool, renameChapterTool]
