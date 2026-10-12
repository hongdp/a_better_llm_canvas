import { describe, it, expect } from 'vitest'
import { calibrationKey, clampRatio, loadTokenRatios, saveTokenRatios, tokenRatio, TOKEN_RATIO_KEY } from '../tokenCalibration'

const memory = () => {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, data }
}

describe('token calibration', () => {
  it("measures the provider's count against the estimate, and only ever shrinks the budget", () => {
    // Sonnet 5.5 on Chinese prose: 333k tokens for what the estimate called 293k.
    expect(tokenRatio(333_611, 293_079)).toBeCloseTo(1.138, 3)
    expect(tokenRatio(100, 1_000)).toBe(1)        // fewer than estimated: taken as 1
    expect(tokenRatio(10_000, 1_000)).toBe(3)     // implausible: capped
    expect(tokenRatio(null, 1_000)).toBeNull()
    expect(tokenRatio(500, 0)).toBeNull()
    expect(clampRatio(0.2)).toBe(1)
  })

  it('keys by provider and model, and survives a reload', () => {
    const store = memory()
    saveTokenRatios(store, { [calibrationKey('anthropic', 'claude-sonnet-5-5')]: 1.14 })
    expect(loadTokenRatios(store)).toEqual({ 'anthropic|claude-sonnet-5-5': 1.14 })
    store.data.set(TOKEN_RATIO_KEY, '{"a|b": "x", "c|d": 9}')
    expect(loadTokenRatios(store)).toEqual({ 'c|d': 3 })
    store.data.set(TOKEN_RATIO_KEY, 'not json')
    expect(loadTokenRatios(store)).toEqual({})
    expect(loadTokenRatios(null)).toEqual({})
  })
})
