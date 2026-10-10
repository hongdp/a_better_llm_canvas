/**
 * Keeping a run's prompt inside the model's window
 * (docs/features/agentic_chat_loop.md §0.9, "Within a run").
 *
 * A run only appends (D4), so a long one that reads chapter after chapter
 * grows its prompt until the provider refuses the step. Grok Build's
 * intra-compaction replaces old tool results with a placeholder once the
 * context passes a threshold; the same here, for the read tools' results:
 * once the prompt passes ELIDE_ABOVE of the prompt limit, the oldest
 * read results (never the latest step's) are replaced by a one-line note
 * naming what was read, until the prompt is back under ELIDE_TO. The note
 * says to read again. Replacing a sent message ends the cached prefix
 * there, which is why this runs only when the step would otherwise not
 * fit. Pure; mirrored by scripts/wc_text/run_compaction.py.
 */
import type { LLMMessage } from '../types/llm'
import { estimateTokens } from '../utils/contextWindow'

/** Elide once the prompt passes this fraction of the limit… */
export const ELIDE_ABOVE = 0.85
/** …and stop once it is under this fraction (or nothing elidable is left). */
export const ELIDE_TO = 0.6

/** A tool result that may be elided: where it sits in the run's messages and what it was. */
export interface ElidableResult {
  index: number
  trace: string
}

export function elidedResultNote(trace: string): string {
  return `[This result was elided to keep the conversation within the model's context window: ${trace}. Read it again if you need its text.]`
}

/** The tokens a step's prompt costs, estimated from every message's text and tool-call arguments. */
export function promptTokens(messages: LLMMessage[]): number {
  let sum = 0
  for (const m of messages) {
    sum += estimateTokens(m.content)
    for (const call of m.toolCalls ?? []) sum += estimateTokens(call.argumentsText)
  }
  return sum
}

export interface ElisionPlan {
  messages: LLMMessage[]
  /** The traces of the results elided, oldest first. */
  elided: string[]
  /** The candidates still intact, for the next check. */
  remaining: ElidableResult[]
}

/** What the last step was really sent: its prompt tokens as the provider counted them, and how many messages that covered. */
export interface MeasuredPrompt {
  tokens: number
  length: number
}

/** How far the measured/estimated ratio may go: past it the measurement is more likely wrong than the estimate. */
const RATIO_MIN = 0.25
const RATIO_MAX = 4

/**
 * The prompt's size in tokens, and the factor that turns an estimate into
 * the provider's count: the measured prefix at its real size, the rest and
 * any change scaled by the prefix's measured/estimated ratio.
 */
export function calibratedPromptTokens(messages: LLMMessage[], measured: MeasuredPrompt | null): { tokens: number; ratio: number } {
  if (!measured || !(measured.tokens > 0) || measured.length <= 0 || measured.length > messages.length) {
    return { tokens: promptTokens(messages), ratio: 1 }
  }
  const estimated = promptTokens(messages.slice(0, measured.length))
  const ratio = estimated > 0 ? Math.min(Math.max(measured.tokens / estimated, RATIO_MIN), RATIO_MAX) : 1
  return { tokens: measured.tokens + promptTokens(messages.slice(measured.length)) * ratio, ratio }
}

/**
 * Replace the oldest elidable results until the prompt fits. Results at or
 * past `keepFrom` (the latest step's) are never touched: the model has not
 * acted on them yet. `measured` calibrates the estimate (§0.9 "Measured").
 */
export function planElisions(messages: LLMMessage[], elidable: ElidableResult[], limitTokens: number, keepFrom: number,
  measured: MeasuredPrompt | null = null): ElisionPlan {
  const untouched: ElisionPlan = { messages, elided: [], remaining: elidable }
  if (!(limitTokens > 0) || elidable.length === 0) return untouched
  const calibrated = calibratedPromptTokens(messages, measured)
  let tokens = calibrated.tokens
  if (tokens <= limitTokens * ELIDE_ABOVE) return untouched
  const out = [...messages]
  const elided: string[] = []
  const remaining: ElidableResult[] = []
  for (const entry of elidable) {
    const m = out[entry.index]
    if (tokens <= limitTokens * ELIDE_TO || entry.index >= keepFrom || !m) {
      remaining.push(entry)
      continue
    }
    const note = elidedResultNote(entry.trace)
    tokens += (estimateTokens(note) - estimateTokens(m.content)) * calibrated.ratio
    out[entry.index] = { ...m, content: note }
    elided.push(entry.trace)
  }
  return elided.length === 0 ? untouched : { messages: out, elided, remaining }
}

/** The line the bubble shows for an elision. */
export function elisionTrace(elided: string[]): string {
  return `🧹 elided ${elided.length} earlier result${elided.length === 1 ? '' : 's'} to stay within the context window`
}
