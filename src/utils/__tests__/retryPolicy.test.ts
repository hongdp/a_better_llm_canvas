/** Which failed model calls are sent again, and after how long (agentic_chat_loop.md §0.10). */
import { describe, it, expect } from 'vitest'
import { isRetryableStatus, isContextLengthError, parseRetryAfter, retryDelayMs, withJitter, MAX_RETRY_DELAY_MS } from '../retryPolicy'

describe('retryPolicy', () => {
  it('retries overload, rate limits and gateway failures, not client errors', () => {
    for (const s of [408, 429, 500, 502, 503, 504, 520, 524, 529]) expect(isRetryableStatus(s, '')).toBe(true)
    for (const s of [400, 401, 403, 404, 413, 422]) expect(isRetryableStatus(s, '')).toBe(false)
  })

  it('never retries a context-length rejection', () => {
    expect(isContextLengthError(400, "This model's maximum context length is 131072 tokens")).toBe(true)
    expect(isContextLengthError(413, 'prompt is too long: 220000 tokens > 200000 maximum')).toBe(true)
    expect(isContextLengthError(400, 'invalid tool schema')).toBe(false)
    expect(isContextLengthError(500, 'context length exceeded')).toBe(false)
  })

  it('reads a numeric Retry-After and ignores dates and junk', () => {
    expect(parseRetryAfter('7')).toBe(7)
    expect(parseRetryAfter(' 1.5 ')).toBe(1.5)
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull()
    expect(parseRetryAfter('0')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
  })

  it('waits Retry-After when given, else doubles from a second, capped', () => {
    expect([1, 2, 3, 4].map(a => retryDelayMs(a, null))).toEqual([1000, 2000, 4000, 8000])
    expect(retryDelayMs(9, null)).toBe(MAX_RETRY_DELAY_MS)
    expect(retryDelayMs(1, 12)).toBe(12_000)
    expect(retryDelayMs(1, 600)).toBe(MAX_RETRY_DELAY_MS)
  })

  it('jitters by ±20 %', () => {
    expect(withJitter(1000, 0)).toBe(800)
    expect(withJitter(1000, 0.5)).toBe(1000)
    expect(withJitter(1000, 0.999)).toBe(1200)
  })
})
