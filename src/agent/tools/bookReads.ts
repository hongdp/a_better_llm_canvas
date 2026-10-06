/**
 * Reading and moving around the book: read_chapter, grep, list_chapters,
 * open_chapter, create_chapter (spec §6, D6).
 *
 * The model finds what it needs from the CHAPTER INDEX it is sent every turn
 * and reads it here — the user no longer attaches chapters by hand (D7).
 */
import { defineTool } from '../registry'
import { citeChapter, resolveChapter, type ResolvedChapter } from '../chapters'
import type { ToolContext, ToolResult } from '../types'
import { stripDiffMarkup } from '../../utils/diff'
import { htmlToPlainText } from '../../utils/llmContext'
import { hashContent } from '../../utils/contextLedger'
import { chapterParagraphs, numberedLine } from '../../utils/paragraphs'
import { pendingChanges, renderPendingChanges } from '../../utils/pendingChanges'
import { forgetChapter, userEdited } from './documentWrites'

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
function acceptedHtml(ctx: ToolContext, id: string): string {
  const working = ctx.run.docs.get(id)
  if (working) return working.html
  return stripDiffMarkup(ctx.document.chapters().find(c => c.id === id)?.content ?? '')
}

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
interface ParagraphRange {
  from: number
  to: number | null
}

/**
 * "40-60", "45", "81-" or [40, 60]. A string error for anything else, so the
 * model learns the syntax instead of silently reading the wrong part.
 */
function parseRange(raw: unknown): ParagraphRange | null | string {
  if (raw === undefined || raw === null || raw === '') return null
  if (Array.isArray(raw) && raw.length >= 1 && raw.length <= 2 && raw.every(n => Number.isInteger(Number(n)))) {
    const [a, b] = raw.map(Number)
    return a >= 1 && (b === undefined || b >= a) ? { from: a, to: b ?? a } : `paragraph range ${JSON.stringify(raw)} is not valid`
  }
  const m = /^\s*¶?(\d+)\s*(?:(-|–|~)\s*¶?(\d+)?)?\s*$/.exec(String(raw))
  if (!m) return `paragraphs must look like "40-60", "45" or "81-", not ${JSON.stringify(raw)}`
  const from = Number(m[1])
  const to = m[3] !== undefined ? Number(m[3]) : m[2] ? null : from
  if (from < 1 || (to !== null && to < from)) return `paragraph range ${JSON.stringify(raw)} is not valid`
  return { from, to }
}

interface ReadArgs {
  refs: unknown[]
  format: 'text' | 'html'
  range: ParagraphRange | null
}

export const readChapterTool = defineTool<ReadArgs>({
  name: 'read_chapter',
  description:
    'Read one or more chapters. Find them in the CHAPTER INDEX and pass their numbers. ' +
    'Format "text" (default) returns numbered paragraphs ("¶12 …"), for reading content and consistency; ' +
    '"html" returns the chapter\'s HTML without numbers, for editing — edits copy their SEARCH text from it. ' +
    'Pass paragraphs (e.g. "40-60", or "81-" for the rest) to read only part of a chapter — after grep found a ¶ number, read around it instead of the whole chapter. ' +
    `A long chapter comes back in parts of at most ${READ_CHAPTER_CAP} characters, ending at a whole paragraph, with the range to continue from. ` +
    'If no title or summary tells you where something is, use grep.',
  parameters: {
    type: 'object',
    properties: {
      chapters: {
        type: 'array',
        description: 'Chapter numbers from the CHAPTER INDEX (or exact titles).',
        items: { type: 'string' }
      },
      format: { type: 'string', description: '"text" (default, numbered paragraphs) or "html" (for editing).' },
      paragraphs: { type: 'string', description: 'Optional paragraph range, e.g. "40-60", "45" or "81-". Default: the whole chapter.' }
    },
    required: ['chapters']
  },
  kind: 'read',
  isAvailable: () => true,
  parse: raw => {
    if (!raw) return 'its arguments could not be parsed'
    const refs = chapterRefs(raw)
    if (refs.length === 0) return 'no chapter was named (pass "chapters": [numbers from the CHAPTER INDEX])'
    const range = parseRange(raw.paragraphs)
    if (typeof range === 'string') return range
    return { refs, format: raw.format === 'html' ? 'html' : 'text', range }
  },
  execute: async ({ refs, format, range }, ctx): Promise<ToolResult> => {
    const chapters = ctx.document.chapters()
    const resolved: ResolvedChapter[] = []
    const errors: string[] = []
    for (const ref of refs) {
      const r = resolveChapter(ref, chapters)
      if (typeof r === 'string') errors.push(r)
      else if (!resolved.some(c => c.id === r.id)) resolved.push(r)
    }
    if (resolved.length === 0) return fail('read_chapter', errors.join('\n'))

    await ctx.document.ensureLoaded(resolved.map(c => c.id))

    const parts: string[] = []
    const traces: string[] = []
    let budget = READ_CALL_CAP
    const skipped: ResolvedChapter[] = []
    for (const chapter of resolved) {
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
        skipped.push(chapter)
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
      parts.push(`=== ${citeChapter(chapter)} — ${paras.length} paragraphs, ${totalChars} characters${span}, ${format} ===\n${lines.join('\n')}${more}${pending ? `\n\n${pending}` : ''}`)
      traces.push(`${citeChapter(chapter)}${whole ? '' : ` ¶${from}–${last}`} (${(used / 1000).toFixed(1)}k, ${format})`)

      ctx.run.reads.set(key, ctx.run.step)
      ctx.run.readIds.add(chapter.id)
      if (format === 'html') {
        ctx.run.htmlShown.add(chapter.id)
        if (!ctx.run.known.has(chapter.id)) ctx.run.known.set(chapter.id, stored)
      }
    }
    if (skipped.length > 0) {
      parts.push(`[Not returned — this call reached its ${READ_CALL_CAP}-character limit: ${skipped.map(citeChapter).join(', ')}. Ask for them in another call.]`)
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
})

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
  pattern: string
  refs: unknown[]
  output: 'snippets' | 'chapters'
  context: number
  maxResults: number
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
    'output "snippets" (default) returns each match with its chapter number, paragraph number (¶) and surrounding text — read around it with read_chapter paragraphs="…"; output "chapters" returns only the chapters that match, with counts. ' +
    'Chapter titles are searched too.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'A JavaScript regular expression, matched case-insensitively. Plain words work as they are.' },
      chapters: { type: 'array', description: 'Optional: limit the search to these chapters (numbers from the CHAPTER INDEX, or titles).', items: { type: 'string' } },
      output: { type: 'string', description: '"snippets" (default) or "chapters".' },
      context: { type: 'integer', description: `Characters of text on each side of a match in snippets. Default ${DEFAULT_CONTEXT}, at most ${MAX_CONTEXT}.` },
      max_results: { type: 'integer', description: `Snippets to return. Default ${DEFAULT_SEARCH_RESULTS}, at most ${MAX_SEARCH_RESULTS}.` }
    },
    required: ['pattern']
  },
  kind: 'read',
  isAvailable: () => true,
  parse: raw => {
    const pattern = typeof raw?.pattern === 'string' ? raw.pattern : typeof raw?.query === 'string' ? raw.query : ''
    if (!pattern.trim()) return 'the pattern was empty'
    const num = (v: unknown, fallback: number, max: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : fallback
    return {
      pattern,
      refs: raw ? chapterRefs(raw) : [],
      output: raw?.output === 'chapters' ? 'chapters' : 'snippets',
      context: num(raw?.context, DEFAULT_CONTEXT, MAX_CONTEXT),
      maxResults: Math.max(1, num(raw?.max_results, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS))
    }
  },
  execute: async ({ pattern, refs, output, context, maxResults }, ctx): Promise<ToolResult> => {
    const all = ctx.document.chapters()
    let scope = all.map((c, i) => ({ ...c, number: i + 1 }))
    if (refs.length > 0) {
      const picked: typeof scope = []
      for (const ref of refs) {
        const r = resolveChapter(ref, all)
        if (typeof r === 'string') return fail('grep', r)
        if (!picked.some(c => c.id === r.id)) picked.push(scope[r.number - 1])
      }
      scope = picked
    }
    await ctx.document.ensureLoaded(scope.map(c => c.id))
    const { re, literal } = compilePattern(pattern)

    const hits: string[] = []
    const perChapter: string[] = []
    let total = 0
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

    const scopeNote = refs.length > 0 ? ` in ${scope.length} chapter(s)` : ''
    const literalNote = literal ? ' (not a valid regular expression; searched as plain text)' : ''
    const head = total === 0
      ? `No matches for /${pattern}/${scopeNote}${literalNote}.`
      : `${total} match(es) in ${perChapter.length} chapter(s)${scopeNote}${literalNote}` +
        (output === 'snippets' && total > hits.length ? `; showing the first ${hits.length}` : '') + ':'
    return {
      ok: true,
      content: [head, ...(output === 'chapters' ? perChapter : hits)].join('\n'),
      trace: `🔎 grep /${pattern}/ → ${total} in ${perChapter.length} chapter(s)`
    }
  }
})

// ── list_chapters ───────────────────────────────────────────────────────────

export const listChaptersTool = defineTool<Record<string, never>>({
  name: 'list_chapters',
  description:
    'The current list of chapters with their numbers, sizes and summaries. The CHAPTER INDEX in the request already has this as of the start of the turn; call this only after creating chapters, or when you need sizes.',
  parameters: { type: 'object', properties: {} },
  kind: 'read',
  isAvailable: () => true,
  parse: () => ({}),
  execute: (_args, ctx): ToolResult => {
    const lines = ctx.document.chapters().map((c, i) => {
      const html = acceptedHtml(ctx, c.id)
      const chars = htmlToPlainText(html).length
      const paras = chapterParagraphs(html).length
      const marks = [
        c.id === ctx.document.openId() ? 'open in the editor' : '',
        ctx.run.created.has(c.id) ? 'created this turn' : '',
        ctx.run.touched.has(c.id) ? 'changed this turn' : ''
      ].filter(Boolean)
      const summary = c.summary?.trim() ? ` — ${c.summary.trim().replace(/\s+/g, ' ').slice(0, 200)}` : ''
      return `${i + 1}. "${c.title}" (${paras} paragraphs, ${chars} chars${marks.length ? `; ${marks.join('; ')}` : ''})${summary}`
    })
    return { ok: true, content: lines.join('\n'), trace: '📚 list chapters' }
  }
})

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
        (ctx.run.htmlShown.has(target.id) ? '' : ' Only edits to parts of it need its HTML first (read_chapter, format "html").'),
      trace: `📂 open ${citeChapter(target)}`
    }
  }
})

// ── create_chapter ──────────────────────────────────────────────────────────

export const createChapterTool = defineTool<{ title: string }>({
  name: 'create_chapter',
  description:
    'Add a new, empty chapter at the end of the book; it opens in the editor at once. Then write its text — in the same reply if you can. ' +
    'Do not create a chapter that already exists in the CHAPTER INDEX: to rewrite an existing chapter, just write to it.',
  parameters: {
    type: 'object',
    properties: { title: { type: 'string', description: 'The chapter title, e.g. "第一章 风起".' } },
    required: ['title']
  },
  kind: 'navigate',
  isAvailable: () => true,
  parse: raw => {
    const title = typeof raw?.title === 'string' ? raw.title.trim() : ''
    return title ? { title } : 'the title was empty'
  },
  execute: ({ title }, ctx): ToolResult => {
    const existing = ctx.document.chapters().findIndex(c => c.title.trim() === title)
    if (existing !== -1) {
      return fail('create_chapter', `A chapter titled "${title}" already exists as #${existing + 1}. Do not create or open it — write to it directly: ${fullWrite(ctx, existing + 1)}.`)
    }
    const id = ctx.document.create(title)
    ctx.run.created.add(id)
    // Empty, and the model made it: nothing to read before writing.
    ctx.run.htmlShown.add(id)
    ctx.run.inContext.add(id)
    ctx.run.known.set(id, ctx.document.chapters().find(c => c.id === id)?.content ?? '')
    const number = ctx.document.chapters().findIndex(c => c.id === id) + 1
    ctx.run.touched.set(id, { documentId: id, titleAtRun: title, kind: 'created', changes: 0, failed: 0 })
    // Opened at once (user decision 2026-10-06): the next step spends 20–60 s
    // planning the chapter before its first word, and the user should be
    // looking at the new chapter meanwhile, not at the old one. Not while a
    // selection rewrite is pending: the selection lives in the open chapter.
    // Nor once the user has gone to another chapter: they may be typing there.
    const selectionPending = ctx.selection.range() !== null && !ctx.run.selectionApplied
    const opened = !selectionPending && !ctx.document.userMoved()
    if (opened) ctx.document.open(id)
    return {
      ok: true,
      content: `Created chapter #${number} "${title}" (empty)${opened ? ', now open in the editor' : ''}. Write its text now: ${fullWrite(ctx, number)}.` +
        (ctx.run.continuesAfterWrites === false
          // Writes end the turn here, so the next chapter must be asked for
          // in the same reply or the series stops after this one.
          ? ' If more chapters follow it, create the next one in that same reply — the turn continues and your next reply writes it.'
          : ''),
      trace: `➕ create #${number} "${title}"`
    }
  }
})

export const BOOK_TOOLS = [readChapterTool, grepTool, listChaptersTool, openChapterTool, createChapterTool]
