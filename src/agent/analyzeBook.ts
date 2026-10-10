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
import { analyzeBatchChars, packChaptersIntoBatches } from '../utils/chapterIndex'
import { cjkRatioOf, estimateTokens } from '../utils/contextWindow'
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

/**
 * Above this many input tokens, analyze_book asks first (agentic_chat_loop.md
 * spec §6 had it behind a consent card; run-737f3d809b45 read a 2M-character
 * attachment whole for a task that needed 60k: 1.58M tokens).
 */
export const ANALYZE_CONFIRM_TOKENS = 200_000
/** Running notes ride along from the second batch on; their share of each call, in tokens. */
const NOTES_ALLOWANCE_TOKENS = 4_000

export interface AnalyzePlan {
  /** Model calls (batches). */
  calls: number
  /** Input tokens across all calls, estimated. */
  inputTokens: number
  /** Characters of chapter text per batch. */
  batchChars: number
}

/** Tags out, cheaply: for sizing only (a 2M-character attachment needs no DOM). */
const roughText = (html: string) => html.replace(/<[^>]*>/g, '')

/** What analyzing these chapters will cost, before any call: batches sized for the provider and the text. */
export function planAnalysis(task: string, chapters: AnalyzeChapter[], provider: string): AnalyzePlan {
  const sample = chapters.slice(0, 5).map(c => roughText(c.content).slice(0, 20_000)).join('')
  const batchChars = analyzeBatchChars(provider, cjkRatioOf(sample))
  const batches = packChaptersIntoBatches(chapters, batchChars)
  const fixed = estimateTokens(SYSTEM) + estimateTokens(task) + 60
  let inputTokens = 0
  batches.forEach((batch, i) => {
    inputTokens += fixed + (i > 0 ? NOTES_ALLOWANCE_TOKENS : 0) + batch.reduce((sum, c) => sum + estimateTokens(roughText(c.content)), 0)
  })
  return { calls: batches.length, inputTokens, batchChars }
}

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
