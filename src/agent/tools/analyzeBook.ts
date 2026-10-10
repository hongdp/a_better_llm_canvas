/**
 * analyze_book: notes from reading the whole book (or the chapters named)
 * in batches, for a task that needs all of it at once (agentic_chat_loop.md
 * D7). The batching is in ../analyzeBook; the model calls come through
 * `ctx.analyze`, which is absent where no model is wired.
 */
import { defineTool } from '../registry'
import { citeChapter } from '../chapters'
import { attachmentList, parseRange, resolveRef, type ParagraphRange } from './bookReads'
import { attachmentChunks, findAttachmentRange, type AttachmentMeta } from '../../utils/attachments'
import { ANALYZE_CONFIRM_TOKENS } from '../analyzeBook'
import type { ToolResult } from '../types'
import { stripDiffMarkup } from '../../utils/diff'

/** Notes returned to the model, at most — the size of one chapter read. */
const NOTES_CAP = 20_000
/** An attachment is cut into pieces of at most this many characters before batching (attachments_and_web.md §1). */
export const ATTACHMENT_CHUNK_CHARS = 40_000

interface AnalyzeArgs {
  task: string
  refs: unknown[]
  /** Attachments only: a section or a run of them, by heading ("第62–87章"). */
  section?: string
  /** Attachments only: a ¶ range ("1203-2890"). Wins over `section`. */
  range: ParagraphRange | null
  confirmed: boolean
}

const thousands = (n: number) => n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n)

export const analyzeBookTool = defineTool<AnalyzeArgs>({
  name: 'analyze_book',
  description:
    'Read every chapter of the book — or the chapters you name — in batches, with a separate model call per batch, and get back notes for a task that needs all of them at once: the plot so far across the whole book, every appearance of a thread or character, consistency checks. ' +
    'One model call per batch (the trace shows how many). For a few chapters read_chapter is cheaper and exact; to find where something appears, use grep. ' +
    'For an attachment (A1), read only the part the task needs: section="第62–87章" (headings) or paragraphs="1203-2890" (¶ numbers, which grep reports; in a novel .txt a ¶ is a line). ' +
    'A run past 200,000 input tokens is not started: you get the estimate, ask the user with ask_user, and call again with confirmed: true if they agree.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'What the notes are for, e.g. "list every promise 晓晓 makes and whether it is kept".' },
      chapters: { type: 'array', items: { type: 'string' }, description: 'Optional: only these chapters (numbers from the CHAPTER INDEX, or titles), or attachments (A1).' },
      section: { type: 'string', description: 'Attachments only: the sections to read, by heading — one ("第三十章") or a run ("第62–87章").' },
      paragraphs: { type: 'string', description: 'Attachments only: a ¶ range, e.g. "1203-2890" or "1203-" (to the end). Wins over section.' },
      confirmed: { type: 'boolean', description: 'true only after the user agreed to a run past 200,000 input tokens.' }
    },
    required: ['task']
  },
  kind: 'read',
  isAvailable: ctx => ctx.analyze !== undefined,
  parse: raw => {
    const task = typeof raw?.task === 'string' ? raw.task.trim() : ''
    if (!task) return 'the task was empty'
    const refs = Array.isArray(raw?.chapters) ? raw.chapters : raw?.chapters !== undefined ? [raw.chapters] : []
    const range = parseRange(raw?.paragraphs)
    if (typeof range === 'string') return range
    const section = typeof raw?.section === 'string' && raw.section.trim() ? raw.section.trim() : undefined
    return { task, refs, range, ...(section ? { section } : {}), confirmed: raw?.confirmed === true }
  },
  execute: async ({ task, refs, section, range, confirmed }, ctx): Promise<ToolResult> => {
    const analyze = ctx.analyze
    if (!analyze) return { ok: false, retryable: false, content: 'No model is available to analyze the book.', trace: '⚠️ analyze_book: not available' }
    const all = ctx.document.chapters()
    let scope = all.map((c, i) => ({ ...c, number: i + 1 }))
    const files: AttachmentMeta[] = []
    if (refs.length > 0) {
      const picked: typeof scope = []
      const known = attachmentList(ctx)
      for (const ref of refs) {
        const r = resolveRef(ref, all, known)
        if ('error' in r) return { ok: false, retryable: true, content: `analyze_book was not run: ${r.error}`, trace: `⚠️ analyze_book: ${r.error.split('\n')[0]}` }
        if ('attachment' in r) {
          if (!files.some(a => a.id === r.attachment.id)) files.push(r.attachment)
        } else if (!picked.some(c => c.id === r.chapter.id)) picked.push(scope[r.chapter.number - 1])
      }
      scope = picked
    }
    if ((section || range) && files.length === 0) {
      return { ok: false, retryable: true, content: 'analyze_book was not run: section and paragraphs pick a part of an attachment (A1); name one in chapters.', trace: '⚠️ analyze_book: section/paragraphs without an attachment' }
    }
    await ctx.document.ensureLoaded(scope.map(c => c.id))
    const now = ctx.document.chapters()
    const unloaded = scope.filter(c => now.find(n => n.id === c.id)?.loaded === false)
    // What the model would read: the run's own copy where it wrote one,
    // otherwise the accepted reading of what is stored.
    const chapters = scope
      .filter(c => !unloaded.includes(c))
      .map(c => ({
        id: c.id,
        title: c.title,
        content: ctx.run.docs.get(c.id)?.html ?? stripDiffMarkup(now.find(n => n.id === c.id)?.content ?? '')
      }))
      .filter(c => c.content.trim())
    // An attachment, or the part of it named: a section per pseudo-chapter, cut to fit a batch.
    const parts: string[] = []
    for (const att of files) {
      const paras = await (ctx.attachments as NonNullable<typeof ctx.attachments>).paragraphs(att.id)
      let span: { from: number; to: number } | null = null
      if (range) {
        span = { from: range.from, to: Math.min(range.to ?? paras.length, paras.length) }
        if (span.from > paras.length) {
          return { ok: false, retryable: true, content: `analyze_book was not run: ${att.ref} has ${paras.length} paragraphs; there is no ¶${span.from}.`, trace: `⚠️ analyze_book: ${att.ref} has no ¶${span.from}` }
        }
        parts.push(`${att.ref} ¶${span.from}–${span.to}`)
      } else if (section) {
        const hit = findAttachmentRange(att.sections, section)
        if (!hit) {
          const sample = att.sections.slice(0, 6).map(s => `"${s.title}"`).join(', ')
          return { ok: false, retryable: true, content: `analyze_book was not run: ${att.ref} "${att.name}" has no section matching "${section}".` + (sample ? ` Its sections begin ${sample}…; grep chapters=["${att.ref}"] for a heading, or pass paragraphs.` : ' It has no section headings; pass paragraphs instead.'), trace: `⚠️ analyze_book: no section "${section}" in ${att.ref}` }
        }
        span = { from: hit.from, to: hit.to }
        parts.push(`${att.ref} ${section}`)
      } else {
        parts.push(att.ref)
      }
      attachmentChunks(att, paras, ATTACHMENT_CHUNK_CHARS, span).forEach((chunk, i) => chapters.push({ id: `${att.id}#${i}`, title: chunk.title, content: chunk.text }))
    }

    // A long read asks first: the estimate goes to the model, which asks the user.
    const plan = analyze.plan?.(task, chapters)
    const labels = [...scope.map(c => `#${c.number}`), ...parts]
    const where = refs.length === 0 ? 'the book' : labels.length <= 4 ? labels.join(', ') : `${labels.length} chapters`
    if (plan && plan.inputTokens > ANALYZE_CONFIRM_TOKENS && !confirmed) {
      return {
        ok: false,
        retryable: false,
        content: `analyze_book was not run: reading ${where} would send about ${plan.inputTokens} input tokens in ${plan.calls} model call${plan.calls === 1 ? '' : 's'}, more than ${ANALYZE_CONFIRM_TOKENS} — ask first. ` +
          'Ask the user with ask_user whether to spend that, giving these numbers. To spend less, read only what the task needs: grep for it and read those paragraphs with read_chapter, or name a part (section="第62–87章" or paragraphs="1203-2890" for an attachment, or fewer chapters). ' +
          'If the user agrees, call analyze_book again with the same arguments and confirmed: true.',
        trace: `📚 analyze_book: ${where} ≈ ${thousands(plan.inputTokens)} tokens in ${plan.calls} calls — asks first`
      }
    }

    const out = await analyze.run(task, chapters, (done, total) => {
      ctx.ui.progress(`📚 reading the book for analysis … batch ${Math.min(done + 1, total)}/${total}`)
    })
    ctx.ui.progress(null)

    const notes = out.notes.length > NOTES_CAP ? `${out.notes.slice(0, NOTES_CAP)}\n[notes cut at ${NOTES_CAP} characters]` : out.notes
    const ended = out.stopped ? ` Stopped by the user after ${out.batches} of ${out.total} batches.`
      : out.failed ? ` Batch ${out.batches + 1} of ${out.total} failed (${out.failed}); the notes cover the batches before it.`
      : ''
    const skipped = unloaded.length > 0 ? `\nNot read — their text could not be loaded: ${unloaded.map(citeChapter).join(', ')}.` : ''
    return {
      ok: out.batches > 0 && !!out.notes,
      retryable: false,
      content: `NOTES from reading ${chapters.length} chapter(s) of ${where} in ${out.batches} batch(es) for: ${task}.${ended}\n${notes || '(no notes)'}${skipped}`,
      trace: `📚 analyzed ${where} — ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}, ${out.batches} model call${out.batches === 1 ? '' : 's'}` +
        (out.stopped ? ' (stopped)' : out.failed ? ' (failed)' : '')
    }
  }
})
