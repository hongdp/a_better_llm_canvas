import { describe, it, expect } from 'vitest'
import {
  getCacheProfile,
  targetPromptTokens
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
