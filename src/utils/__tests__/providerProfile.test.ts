import { describe, it, expect } from 'vitest'
import {
  getCacheProfile,
  targetPromptTokens,
  checkThreshold,
  readCachedTokens
} from '../providerProfile'

describe('getCacheProfile', () => {
  it('knows grok caches automatically and marks nothing', () => {
    const p = getCacheProfile('grok')
    expect(p.mode).toBe('automatic')
    expect(p.maxBreakpoints).toBe(0)          // cacheHint is inert here
    expect(p.routing?.name).toBe('x-grok-conv-id')
  })

  it('knows anthropic needs explicit breakpoints', () => {
    const p = getCacheProfile('anthropic')
    expect(p.mode).toBe('explicit')
    expect(p.maxBreakpoints).toBe(4)
  })

  it('knows the local endpoint owns a single shared cache', () => {
    // --parallel 1: one slot, so any other request evicts the conversation.
    expect(getCacheProfile('ollama').exclusiveCache).toBe(true)
    expect(getCacheProfile('grok').exclusiveCache).toBe(false)
  })

  it('knows only the local endpoint reports its own window', () => {
    expect(getCacheProfile('ollama').windowDiscovered).toBe(true)
    expect(getCacheProfile('grok').windowDiscovered).toBe(false)
  })

  it('assumes nothing for an unknown provider', () => {
    const p = getCacheProfile('something-new')
    expect(p.mode).toBe('none')
    expect(p.exclusiveCache).toBe(false)
  })
})

describe('targetPromptTokens', () => {
  it('aims below the price cliff, not at the window', () => {
    // grok doubles input, cached AND output rates above the threshold.
    expect(targetPromptTokens(getCacheProfile('grok'), 256_000)).toBe(200_000)
  })

  it('uses the whole window when the cliff is above it', () => {
    expect(targetPromptTokens(getCacheProfile('grok'), 131_072)).toBe(131_072)
  })

  it('uses the whole window when there is no cliff', () => {
    expect(targetPromptTokens(getCacheProfile('ollama'), 262_144)).toBe(262_144)
  })
})

describe('checkThreshold', () => {
  it('reports a crossing with the overshoot', () => {
    const r = checkThreshold(getCacheProfile('grok'), 214_000)!
    expect(r.crossed).toBe(true)
    expect(r.threshold).toBe(200_000)
    expect(r.overBy).toBe(14_000)
  })

  it('reports staying under', () => {
    const r = checkThreshold(getCacheProfile('grok'), 190_000)!
    expect(r.crossed).toBe(false)
    expect(r.overBy).toBe(0)
  })

  it('is null where the provider has no cliff', () => {
    expect(checkThreshold(getCacheProfile('ollama'), 500_000)).toBeNull()
  })
})

describe('readCachedTokens', () => {
  it('reads the OpenAI-shaped path grok uses', () => {
    const usage = { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } }
    expect(readCachedTokens(getCacheProfile('grok'), usage)).toBe(80)
  })

  it('reads the flat field anthropic uses', () => {
    expect(readCachedTokens(getCacheProfile('anthropic'), { cache_read_input_tokens: 42 })).toBe(42)
  })

  it('returns null rather than 0 when the field is absent', () => {
    // 0 would read as "nothing was cached"; null means "this provider did not
    // say", which is the truth for a local endpoint.
    expect(readCachedTokens(getCacheProfile('grok'), { prompt_tokens: 10 })).toBeNull()
    expect(readCachedTokens(getCacheProfile('ollama'), { anything: 1 })).toBeNull()
  })

  it('survives a malformed usage object', () => {
    expect(readCachedTokens(getCacheProfile('grok'), null)).toBeNull()
    expect(readCachedTokens(getCacheProfile('grok'), { prompt_tokens_details: 'nope' })).toBeNull()
  })
})
