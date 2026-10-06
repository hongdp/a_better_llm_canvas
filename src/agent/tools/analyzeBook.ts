/**
 * analyze_book: notes from reading the whole book (or the chapters named)
 * in batches, for a task that needs all of it at once (agentic_chat_loop.md
 * D7). The batching is in ../analyzeBook; the model calls come through
 * `ctx.analyze`, which is absent where no model is wired.
 */
import { defineTool } from '../registry'
import { citeChapter, resolveChapter } from '../chapters'
import type { ToolResult } from '../types'
import { stripDiffMarkup } from '../../utils/diff'

/** Notes returned to the model, at most — the size of one chapter read. */
const NOTES_CAP = 20_000

export const analyzeBookTool = defineTool<{ task: string; refs: unknown[] }>({
  name: 'analyze_book',
  description:
    'Read every chapter of the book — or the chapters you name — in batches, with a separate model call per batch, and get back notes for a task that needs all of them at once: the plot so far across the whole book, every appearance of a thread or character, consistency checks. ' +
    'One model call per batch (the trace shows how many). For a few chapters read_chapter is cheaper and exact; to find where something appears, use grep.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'What the notes are for, e.g. "list every promise 晓晓 makes and whether it is kept".' },
      chapters: { type: 'array', items: { type: 'string' }, description: 'Optional: only these chapters (numbers from the CHAPTER INDEX, or titles).' }
    },
    required: ['task']
  },
  kind: 'read',
  isAvailable: ctx => ctx.analyze !== undefined,
  parse: raw => {
    const task = typeof raw?.task === 'string' ? raw.task.trim() : ''
    if (!task) return 'the task was empty'
    const refs = Array.isArray(raw?.chapters) ? raw.chapters : raw?.chapters !== undefined ? [raw.chapters] : []
    return { task, refs }
  },
  execute: async ({ task, refs }, ctx): Promise<ToolResult> => {
    const analyze = ctx.analyze
    if (!analyze) return { ok: false, retryable: false, content: 'No model is available to analyze the book.', trace: '⚠️ analyze_book: not available' }
    const all = ctx.document.chapters()
    let scope = all.map((c, i) => ({ ...c, number: i + 1 }))
    if (refs.length > 0) {
      const picked: typeof scope = []
      for (const ref of refs) {
        const r = resolveChapter(ref, all)
        if (typeof r === 'string') return { ok: false, retryable: true, content: `analyze_book was not run: ${r}`, trace: `⚠️ analyze_book: ${r.split('\n')[0]}` }
        if (!picked.some(c => c.id === r.id)) picked.push(scope[r.number - 1])
      }
      scope = picked
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

    const out = await analyze.run(task, chapters, (done, total) => {
      ctx.ui.progress(`📚 reading the book for analysis … batch ${Math.min(done + 1, total)}/${total}`)
    })
    ctx.ui.progress(null)

    const where = refs.length === 0 ? 'the book' : scope.length <= 4 ? scope.map(c => `#${c.number}`).join(', ') : `${scope.length} chapters`
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
