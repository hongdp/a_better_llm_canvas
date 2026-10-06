/**
 * analyze_book, the pure half: read chapters in book-order batches, one
 * model call per batch, carrying running notes from batch to batch, and
 * return the notes (agentic_chat_loop.md D7).
 *
 * This was the whole-book "batched" mode (Rung 2), started by a toggle and a
 * cost consent card. It is a tool now: the model calls it when a task needs
 * the whole book at once and the book is too long to read chapter by
 * chapter. Its call count shows in the step trace instead of a card.
 */
import { packChaptersIntoBatches } from '../utils/chapterIndex'
import { htmlToPlainText, truncateWithNotice } from '../utils/llmContext'

/** One model call: system prompt, user message, abort signal → reply text. */
export type AnalyzeTransport = (system: string, user: string, signal?: AbortSignal) => Promise<string>

export interface AnalyzeChapter {
  id: string
  title: string
  /** HTML (the accepted reading); sent as plain text. */
  content: string
}

export interface AnalyzeOutcome {
  notes: string
  /** Batches read (fewer than `total` when stopped or failed). */
  batches: number
  total: number
  /** Stopped by the user (the run's abort signal). */
  stopped: boolean
  /** A batch call failed for another reason. */
  failed?: string
}

const SYSTEM = 'You are analyzing a book chapter-by-chapter in batches to complete a task. Each round you receive your running notes and a new batch of chapters. Update and extend the notes with everything from this batch that matters for the task (structure, plot, entities, facts, quotes). Output ONLY the updated complete notes as plain text. Do NOT produce a final answer.'

export async function analyzeInBatches(opts: {
  task: string
  chapters: AnalyzeChapter[]
  /** Characters of chapter text per call. */
  budgetChars: number
  transport: AnalyzeTransport
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<AnalyzeOutcome> {
  const batches = packChaptersIntoBatches(opts.chapters, opts.budgetChars)
  let notes = ''
  for (let i = 0; i < batches.length; i++) {
    if (opts.signal?.aborted) return { notes, batches: i, total: batches.length, stopped: true }
    opts.onProgress?.(i, batches.length)
    const text = batches[i]
      .map(c => `--- DOCUMENT: ${c.title} ---\n${truncateWithNotice(htmlToPlainText(c.content), opts.budgetChars)}`)
      .join('\n\n')
    const user = `TASK (do not answer it — only update the notes):\n${opts.task}\n\n` +
      `RUNNING NOTES (from previous batches):\n${notes || '(none yet — this is the first batch)'}\n\n` +
      `NEW CHAPTERS (batch ${i + 1} of ${batches.length}):\n${text}`
    try {
      const reply = (await opts.transport(SYSTEM, user, opts.signal)).trim()
      if (reply) notes = reply
    } catch (e) {
      if (opts.signal?.aborted) return { notes, batches: i, total: batches.length, stopped: true }
      return { notes, batches: i, total: batches.length, stopped: false, failed: e instanceof Error ? e.message : String(e) }
    }
  }
  opts.onProgress?.(batches.length, batches.length)
  return { notes, batches: batches.length, total: batches.length, stopped: false }
}
