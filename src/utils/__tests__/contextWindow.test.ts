import { describe, it, expect } from 'vitest'
import {
  resolveContextWindowTokens,
  estimateTokens,
  tokensToChars,
  historyBudgetChars,
  cjkRatioOf,
  MIN_HISTORY_CHARS
} from '../contextWindow'

describe('resolveContextWindowTokens', () => {
  it('takes what the endpoint reported over anything hard-coded', () => {
    // llama.cpp was restarted from 32K to 262144 in a single day; a table
    // cannot track that, so a reported value always wins.
    expect(resolveContextWindowTokens('ollama', 'qwen3.8-flash-next', 262_144)).toBe(262_144)
    expect(resolveContextWindowTokens('grok', 'grok-4.6', 8_192)).toBe(8_192)
  })

  it('matches the longest model prefix, not the first', () => {
    expect(resolveContextWindowTokens('openai', 'gpt-4-turbo-2024')).toBe(128_000)
    expect(resolveContextWindowTokens('openai', 'gpt-4')).toBe(8_192)
  })

  it('falls back to the provider, then to a floor', () => {
    expect(resolveContextWindowTokens('anthropic', 'something-unreleased')).toBe(200_000)
    expect(resolveContextWindowTokens('ollama', 'a-local-model-nobody-knows')).toBe(32_768)
    expect(resolveContextWindowTokens('unknown-provider', 'unknown-model')).toBe(32_768)
  })

  it('ignores a zero or negative discovery', () => {
    expect(resolveContextWindowTokens('grok', 'grok-3', 0)).toBe(131_072)
  })
})

describe('estimateTokens', () => {
  it('counts a CJK character as about one token', () => {
    // 19 Chinese characters ≈ 19 tokens, not the 5 that length/4 predicts.
    expect(estimateTokens('江湖之远庙堂之高剑客独行于风雪之中心念')).toBe(19)
  })

  it('counts latin text at about four characters per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('handles mixed text without collapsing to either rule', () => {
    const mixed = '剑客'.repeat(10) + 'a'.repeat(40)  // 20 CJK + 40 latin
    expect(estimateTokens(mixed)).toBe(30)
  })

  it('is zero for empty input', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('historyBudgetChars', () => {
  const base = { contextTokens: 262_144, maxOutputTokens: 16_384, fixedTokens: 40_000, cjkRatio: 1 }

  it('spends the window that is left after output, fixed content and safety', () => {
    // 262144 - 16384 - 40000 - 26215 (10% safety) = 179,545 tokens ≈ chars at
    // a CJK ratio of 1.
    expect(historyBudgetChars(base)).toBe(179_545)
  })

  it('gives more characters for latin-heavy conversations', () => {
    expect(historyBudgetChars({ ...base, cjkRatio: 0 })).toBe(179_545 * 4)
  })

  it('never returns less than the floor, however tight the window', () => {
    expect(historyBudgetChars({ ...base, contextTokens: 8_192, fixedTokens: 100_000 }))
      .toBe(MIN_HISTORY_CHARS)
  })

  it('scales with the model, which is the whole point', () => {
    const small = historyBudgetChars({ ...base, contextTokens: 32_768, fixedTokens: 4_000 })
    const large = historyBudgetChars({ ...base, contextTokens: 262_144, fixedTokens: 4_000 })
    expect(large).toBeGreaterThan(small * 5)
  })
})

describe('tokensToChars / cjkRatioOf', () => {
  it('converts by the mix', () => {
    expect(tokensToChars(1000, 1)).toBe(1000)
    expect(tokensToChars(1000, 0)).toBe(4000)
    expect(tokensToChars(1000, 0.5)).toBe(2500)
  })

  it('clamps a nonsense ratio instead of producing a nonsense budget', () => {
    expect(tokensToChars(1000, 5)).toBe(1000)
    expect(tokensToChars(1000, -1)).toBe(4000)
  })

  it('measures the CJK share of a string', () => {
    expect(cjkRatioOf('剑客abcd')).toBeCloseTo(2 / 6)
    expect(cjkRatioOf('')).toBe(0)
  })
})
