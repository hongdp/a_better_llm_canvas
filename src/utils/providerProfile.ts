/**
 * What each provider's prompt cache actually does, in one table.
 *
 * The prompt layout in cache_first_context.md is provider-agnostic — an
 * unchanged prefix helps everywhere. What is NOT agnostic is how the cache is
 * triggered, how it is measured, and what it costs when a prompt grows. Those
 * differences were previously scattered (a header set in two transports, a
 * usage field parsed in two more) or simply absent.
 *
 * See docs/features/context_engine.md §3.
 */

import type { LLMProvider } from '../types/llm'

export interface ProviderCacheProfile {
  /**
   * `automatic` — the provider matches an exact prefix on its own.
   * `explicit`  — we must mark breakpoints (`cacheHint` → `cache_control`).
   * `none`      — no prompt cache; layout still helps nothing.
   */
  mode: 'automatic' | 'explicit' | 'none'
  /** Cap on marked breakpoints. Meaningless when `mode !== 'explicit'`. */
  maxBreakpoints: number
  /** How a conversation is pinned to the same cache, if it can be. */
  routing?: { kind: 'header'; name: string }
  /**
   * Total prompt tokens above which the price tier changes. xAI counts CACHED
   * tokens toward this, so an append-only ledger can cross it while the hit
   * rate still looks healthy — the bill doubles quietly.
   */
  longContextThreshold?: number
  /** Path into the usage object where cache hits are reported, if at all. */
  cachedTokensPath?: string[]
  /**
   * True when the cache is one shared slot that any other request evicts —
   * `llama-server --parallel 1`. Background work against such an endpoint
   * destroys the conversation's prefix.
   */
  exclusiveCache: boolean
  /** Whether the endpoint states its own context window. */
  windowDiscovered: boolean
}

const PROFILES: Record<string, ProviderCacheProfile> = {
  // Automatic, exact-prefix. cache_control does not exist here, so `cacheHint`
  // is inert and the layout is the whole optimization. Verified in the xAI
  // docs and against this codebase: both transports already send the header
  // and parse the usage field.
  grok: {
    mode: 'automatic',
    maxBreakpoints: 0,
    routing: { kind: 'header', name: 'x-grok-conv-id' },
    longContextThreshold: 200_000,
    cachedTokensPath: ['prompt_tokens_details', 'cached_tokens'],
    exclusiveCache: false,
    windowDiscovered: false
  },
  // llama.cpp reuses the longest matching prefix held in its slot's KV cache.
  // With --parallel 1 that is a single slot: whoever spoke last owns it.
  ollama: {
    mode: 'automatic',
    maxBreakpoints: 0,
    exclusiveCache: true,
    windowDiscovered: true
  },
  anthropic: {
    mode: 'explicit',
    maxBreakpoints: 4,
    cachedTokensPath: ['cache_read_input_tokens'],
    exclusiveCache: false,
    windowDiscovered: false
  },
  openai: {
    mode: 'automatic',
    maxBreakpoints: 0,
    routing: { kind: 'header', name: 'prompt-cache-key' },
    cachedTokensPath: ['prompt_tokens_details', 'cached_tokens'],
    exclusiveCache: false,
    windowDiscovered: false
  },
  gemini: {
    mode: 'automatic',
    maxBreakpoints: 0,
    cachedTokensPath: ['cachedContentTokenCount'],
    exclusiveCache: false,
    windowDiscovered: false
  }
}

/** Conservative default: assume nothing is cached and nothing is reported. */
const UNKNOWN_PROFILE: ProviderCacheProfile = {
  mode: 'none',
  maxBreakpoints: 0,
  exclusiveCache: false,
  windowDiscovered: false
}

export function getCacheProfile(provider: LLMProvider | string): ProviderCacheProfile {
  return PROFILES[provider] ?? UNKNOWN_PROFILE
}

/**
 * The prompt size to aim for, in tokens.
 *
 * Where a provider has a long-context price cliff, the target is the largest
 * prompt that stays UNDER it — not the largest the window allows. Crossing is
 * a decision with a price attached, never a side effect of one more chapter.
 */
export function targetPromptTokens(
  profile: ProviderCacheProfile,
  contextWindowTokens: number
): number {
  if (profile.longContextThreshold && profile.longContextThreshold < contextWindowTokens) {
    return profile.longContextThreshold
  }
  return contextWindowTokens
}

export interface ThresholdCrossing {
  crossed: boolean
  threshold: number
  promptTokens: number
  /** Tokens over the line; 0 when under it. */
  overBy: number
}

/**
 * Would this prompt cross the price cliff? Cached tokens count — that is the
 * whole trap, since a well-cached conversation looks cheap right up to the
 * point where every rate doubles.
 */
export function checkThreshold(
  profile: ProviderCacheProfile,
  promptTokens: number
): ThresholdCrossing | null {
  if (!profile.longContextThreshold) return null
  const threshold = profile.longContextThreshold
  return {
    crossed: promptTokens > threshold,
    threshold,
    promptTokens,
    overBy: Math.max(0, promptTokens - threshold)
  }
}

/** Read the provider's cache-hit count out of a usage object, if it reports one. */
export function readCachedTokens(
  profile: ProviderCacheProfile,
  usage: unknown
): number | null {
  if (!profile.cachedTokensPath) return null
  let node: unknown = usage
  for (const key of profile.cachedTokensPath) {
    if (!node || typeof node !== 'object') return null
    node = (node as Record<string, unknown>)[key]
  }
  return typeof node === 'number' ? node : null
}
