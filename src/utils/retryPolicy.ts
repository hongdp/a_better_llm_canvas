/**
 * When a model call that failed is worth sending again, and how long to wait
 * (docs/features/agentic_chat_loop.md §0.10; after Grok Build's sampler).
 *
 * Pure. The transports apply it: the backend job (server_generation.run_job)
 * and the tab's direct path (services/llm.ts). Mirrored by
 * scripts/wc_text/retry_policy.py — change both together.
 */

/** More attempts after the first. */
export const MAX_TRANSPORT_RETRIES = 4
/** The longest wait between attempts, Retry-After included. */
export const MAX_RETRY_DELAY_MS = 30_000
const BASE_DELAY_MS = 1_000
/** Rate limits, overload, gateway and edge failures: the same request may succeed later. */
export const RETRYABLE_STATUSES: readonly number[] = [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]

const CONTEXT_LENGTH_RE = /context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|input is too long|exceeds the (?:model'?s )?(?:maximum|context)/i

/** A rejection for size: sending it again cannot help, whatever the status says. */
export function isContextLengthError(status: number, message: string): boolean {
  return (status === 400 || status === 413 || status === 422) && CONTEXT_LENGTH_RE.test(message || '')
}

export function isRetryableStatus(status: number, message: string): boolean {
  return RETRYABLE_STATUSES.includes(status) && !isContextLengthError(status, message)
}

/** A Retry-After header in seconds, when it is a number (an HTTP date is ignored). */
export function parseRetryAfter(value: string | null | undefined): number | null {
  const trimmed = (value ?? '').trim()
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null
  const seconds = Number(trimmed)
  return seconds > 0 ? seconds : null
}

/** The wait before attempt `attempt` (1 = the first retry): Retry-After when given, else 1, 2, 4, 8 s; capped. */
export function retryDelayMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) return Math.min(Math.round(retryAfterSeconds * 1000), MAX_RETRY_DELAY_MS)
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS)
}

/** ±20 %, from `unit` in [0, 1): the caller passes Math.random() (tests pass a constant). */
export function withJitter(ms: number, unit: number): number {
  return Math.round(ms * (0.8 + 0.4 * Math.min(Math.max(unit, 0), 1)))
}
