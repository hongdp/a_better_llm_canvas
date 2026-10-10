/**
 * The tab's direct transport sends a call again while it fails before its
 * stream opened (agentic_chat_loop.md §0.10).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withTransportRetry, ProviderHttpError } from '../llm'

const noWait = { sleep: vi.fn<(ms: number) => Promise<void>>(async () => {}), random: () => 0.5 }
beforeEach(() => {
  noWait.sleep.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('withTransportRetry', () => {
  it('retries a 503 and returns what the next attempt returns', async () => {
    let n = 0
    const out = await withTransportRetry(async () => {
      if (++n < 3) throw new ProviderHttpError('xAI API error (503): busy', 503, null)
      return 'ok'
    }, undefined, noWait)
    expect(out).toBe('ok')
    expect(n).toBe(3)
    expect(noWait.sleep.mock.calls.map(c => c[0])).toEqual([1000, 2000])
  })

  it('waits what Retry-After says', async () => {
    let n = 0
    await withTransportRetry(async () => { if (++n === 1) throw new ProviderHttpError('rate limited', 429, 9) }, undefined, noWait)
    expect(noWait.sleep.mock.calls[0][0]).toBe(9000)
  })

  it('does not retry a bad request or a context-length rejection', async () => {
    for (const err of [new ProviderHttpError('bad', 400, null), new ProviderHttpError("maximum context length is 8192", 400, null)]) {
      let n = 0
      await expect(withTransportRetry(async () => { n++; throw err }, undefined, noWait)).rejects.toBe(err)
      expect(n).toBe(1)
    }
  })

  it('retries a failed fetch, not a programming error', async () => {
    let n = 0
    await withTransportRetry(async () => { if (++n === 1) throw new TypeError('Failed to fetch') }, undefined, noWait)
    expect(n).toBe(2)
    let m = 0
    await expect(withTransportRetry(async () => { m++; throw new TypeError("Cannot read properties of undefined (reading 'x')") }, undefined, noWait)).rejects.toThrow(TypeError)
    expect(m).toBe(1)
  })

  it('gives up after four retries', async () => {
    let n = 0
    await expect(withTransportRetry(async () => { n++; throw new ProviderHttpError('down', 502, null) }, undefined, noWait)).rejects.toThrow('down')
    expect(n).toBe(5)
  })

  it('stops waiting when the user stops', async () => {
    const controller = new AbortController()
    let n = 0
    const sleep = vi.fn(async () => { controller.abort() })
    await expect(withTransportRetry(async () => { n++; throw new ProviderHttpError('busy', 503, null) }, controller.signal, { sleep, random: () => 0.5 }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(n).toBe(1)
  })
})
