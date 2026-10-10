/**
 * Reading for a task: what `read` does when what it was asked for does not
 * fit in one call and a `task` says what the notes are for (read_and_list.md
 * §2; formerly the analyze_book tool, agentic_chat_loop.md D7). The text is
 * read in batches OUTSIDE the conversation, one model call per batch, and
 * notes come back. The batching is in ../analyzeBook; the model calls come
 * through `ctx.analyze`, absent where no model is wired.
 */
import { citeChapter } from '../chapters'
import { acceptedHtml, attachmentList, resolveRef, type ParagraphRange } from './bookReads'
import { attachmentChunks, findAttachmentRange, type AttachmentMeta } from '../../utils/attachments'
import { chapterParagraphs } from '../../utils/paragraphs'
import { ANALYZE_CONFIRM_TOKENS, type AnalyzeChapter } from '../analyzeBook'
import type { ToolContext, ToolResult } from '../types'

/** Notes returned to the model, at most — the size of one chapter read. */
const NOTES_CAP = 20_000
/** An attachment is cut into pieces of at most this many characters before batching (attachments_and_web.md §1). */
export const ATTACHMENT_CHUNK_CHARS = 40_000

/** One thing to read, as `read` takes it. */
export interface AnalysisItem {
  ref: unknown
  range: ParagraphRange | null
  /** Attachments only: a section, or a run of them, by heading. */
  section?: string
}

const thousands = (n: number) => n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n)
const refused = (content: string, line: string): ToolResult =>
  ({ ok: false, retryable: true, content: `read was not run: ${content}`, trace: `⚠️ read: ${line}` })

interface Collected {
  chapters: AnalyzeChapter[]
  /** What was named, for the trace: "#3", "#5 ¶10–40", "A1 第62–87章". */
  labels: string[]
  unloaded: string[]
}

/**
 * What a task-read would send: the chapters (or their ranges) and the
 * attachments (or their parts) as pseudo-chapters. No items = the whole book.
 */
async function collect(items: AnalysisItem[], ctx: ToolContext): Promise<Collected | ToolResult> {
  const all = ctx.document.chapters()
  const known = attachmentList(ctx)
  const wanted: Array<{ chapter: { id: string; title: string; number: number }; range: ParagraphRange | null } | { attachment: AttachmentMeta; range: ParagraphRange | null; section?: string }> = []
  if (items.length === 0) {
    all.forEach((c, i) => wanted.push({ chapter: { id: c.id, title: c.title, number: i + 1 }, range: null }))
  } else {
    for (const item of items) {
      const r = resolveRef(item.ref, all, known)
      if ('error' in r) return refused(r.error, r.error.split('\n')[0])
      if ('attachment' in r) wanted.push({ attachment: r.attachment, range: item.range, ...(item.section ? { section: item.section } : {}) })
      else if (item.section) return refused(`section="${item.section}" names a part of an attachment; for a chapter, pass paragraphs.`, 'section on a chapter')
      else wanted.push({ chapter: r.chapter, range: item.range })
    }
  }
  await ctx.document.ensureLoaded(wanted.flatMap(w => ('chapter' in w ? [w.chapter.id] : [])))
  const now = ctx.document.chapters()
  const out: Collected = { chapters: [], labels: [], unloaded: [] }
  for (const w of wanted) {
    if ('chapter' in w) {
      const c = w.chapter
      if (now.find(n => n.id === c.id)?.loaded === false) { out.unloaded.push(citeChapter(c)); continue }
      const html = acceptedHtml(ctx, c.id)
      if (!w.range) {
        if (html.trim()) out.chapters.push({ id: c.id, title: c.title, content: html })
        out.labels.push(`#${c.number}`)
        continue
      }
      const paras = chapterParagraphs(html)
      const to = Math.min(w.range.to ?? paras.length, paras.length)
      const text = paras.filter(p => p.number >= w.range!.from && p.number <= to).map(p => p.text).join('\n')
      if (text.trim()) out.chapters.push({ id: `${c.id}#${w.range.from}`, title: `${c.title} (¶${w.range.from}–${to})`, content: text })
      out.labels.push(`#${c.number} ¶${w.range.from}–${to}`)
      continue
    }
    const att = w.attachment
    const paras = await (ctx.attachments as NonNullable<ToolContext['attachments']>).paragraphs(att.id)
    let span: { from: number; to: number } | null = null
    if (w.range) {
      span = { from: w.range.from, to: Math.min(w.range.to ?? paras.length, paras.length) }
      if (span.from > paras.length) return refused(`${att.ref} has ${paras.length} paragraphs; there is no ¶${span.from}.`, `${att.ref} has no ¶${span.from}`)
      out.labels.push(`${att.ref} ¶${span.from}–${span.to}`)
    } else if (w.section) {
      const hit = findAttachmentRange(att.sections, w.section)
      if (!hit) {
        const sample = att.sections.slice(0, 6).map(s => `"${s.title}"`).join(', ')
        return refused(`${att.ref} "${att.name}" has no section matching "${w.section}".` +
          (sample ? ` Its sections begin ${sample}…; list source="${att.ref}" shows them all, or pass paragraphs.` : ' It has no section headings; pass paragraphs instead.'),
        `no section "${w.section}" in ${att.ref}`)
      }
      span = { from: hit.from, to: hit.to }
      out.labels.push(`${att.ref} ${w.section}`)
    } else {
      out.labels.push(att.ref)
    }
    attachmentChunks(att, paras, ATTACHMENT_CHUNK_CHARS, span).forEach((chunk, i) => out.chapters.push({ id: `${att.id}#${span?.from ?? 0}-${i}`, title: chunk.title, content: chunk.text }))
  }
  return out
}

const isResult = (x: Collected | ToolResult): x is ToolResult => 'ok' in x

/**
 * Read for a task: batches outside the conversation, notes back. Past
 * ANALYZE_CONFIRM_TOKENS of estimated input it is not started: the model
 * gets the estimate to ask the user, and calls again with confirmed: true.
 */
export async function readForTask(task: string, items: AnalysisItem[], confirmed: boolean, ctx: ToolContext): Promise<ToolResult> {
  const analyze = ctx.analyze
  if (!analyze) {
    return { ok: false, retryable: false, content: 'This is more than one read returns, and no model is available here to read it in batches: read it part by part, by paragraph ranges.', trace: '⚠️ read: too long for one read, no batch reading here' }
  }
  const got = await collect(items, ctx)
  if (isResult(got)) return got
  const where = items.length === 0 ? 'the book' : got.labels.length <= 4 ? got.labels.join(', ') : `${got.labels.length} parts`
  const plan = analyze.plan?.(task, got.chapters)
  if (plan && plan.inputTokens > ANALYZE_CONFIRM_TOKENS && !confirmed) {
    return {
      ok: false,
      retryable: false,
      content: `read was not run: reading ${where} for this task would send about ${plan.inputTokens} input tokens in ${plan.calls} model call${plan.calls === 1 ? '' : 's'}, more than ${ANALYZE_CONFIRM_TOKENS} — ask first. ` +
        'Ask the user with ask_user whether to spend that, giving these numbers. To spend less, read only what the task needs: grep for it and read those paragraphs, or name a part (section="第62–87章" or paragraphs="1203-2890" for an attachment — list source="A1" shows its sections — or fewer chapters). ' +
        'If the user agrees, call read again with the same arguments and confirmed: true.',
      trace: `📚 read for a task: ${where} ≈ ${thousands(plan.inputTokens)} tokens in ${plan.calls} calls — asks first`
    }
  }
  const out = await analyze.run(task, got.chapters, (done, total) => {
    ctx.ui.progress(`📚 reading for the task … batch ${Math.min(done + 1, total)}/${total}`)
  })
  ctx.ui.progress(null)
  const notes = out.notes.length > NOTES_CAP ? `${out.notes.slice(0, NOTES_CAP)}\n[notes cut at ${NOTES_CAP} characters]` : out.notes
  const ended = out.stopped ? ` Stopped by the user after ${out.batches} of ${out.total} batches.`
    : out.failed ? ` Batch ${out.batches + 1} of ${out.total} failed (${out.failed}); the notes cover the batches before it.`
    : ''
  const skipped = got.unloaded.length > 0 ? `\nNot read — their text could not be loaded: ${got.unloaded.join(', ')}.` : ''
  const n = got.chapters.length
  return {
    ok: out.batches > 0 && !!out.notes,
    retryable: false,
    content: `NOTES from reading ${n} part(s) of ${where} in ${out.batches} batch(es) for: ${task}.${ended}\n${notes || '(no notes)'}${skipped}`,
    trace: `📚 read ${where} for a task — ${n} part${n === 1 ? '' : 's'}, ${out.batches} model call${out.batches === 1 ? '' : 's'}` +
      (out.stopped ? ' (stopped)' : out.failed ? ' (failed)' : '')
  }
}

/**
 * What reading all of an over-long request would cost, for the note under a
 * cut read: the model sees the price before it asks for the batches.
 */
export async function restOfReadNote(items: AnalysisItem[], ctx: ToolContext): Promise<string> {
  if (!ctx.analyze?.plan) return ''
  const got = await collect(items, ctx)
  if (isResult(got) || got.chapters.length === 0) return ''
  const plan = ctx.analyze.plan('(estimate)', got.chapters)
  return `[Not all of it fit in one read. To have all of it read and get notes, call read again with the same arguments and task="what the notes are for": ` +
    `${plan.calls} batch${plan.calls === 1 ? '' : 'es'} outside the conversation, ≈${thousands(plan.inputTokens)} input tokens` +
    (plan.inputTokens > ANALYZE_CONFIRM_TOKENS ? ', which needs the user\'s yes first' : '') + '.]'
}
