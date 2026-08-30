/**
 * How much context the active model actually has, and how much of it the chat
 * history may use.
 *
 * Problem: the history window was a flat `MAX_HISTORY_CHARS = 80_000`, chosen
 *   once and applied to every provider. It is simultaneously too small (a
 *   262144-token local endpoint could hold the entire conversation and was
 *   being trimmed at ~20k tokens of Chinese) and too large (a 32k-token model
 *   would be handed a prompt it must silently truncate). Trimming is also the
 *   single most expensive thing we can do to a cached prefix — it rewrites the
 *   FRONT of the history, so every token after it must be prefilled again.
 * Fix: budget against the model's real window, and prefer a number the server
 *   reported over anything hard-coded here.
 */

import type { LLMProvider } from '../types/llm'

/**
 * Tokens per model, for providers that do not report it. Matched
 * longest-prefix-first, so a family entry covers its variants.
 *
 * These are the published context windows; they are a FALLBACK. Any endpoint
 * that states its own window (llama.cpp reports `meta.n_ctx` on /v1/models)
 * overrides the table, because only the server knows what it was started with.
 */
const MODEL_CONTEXT_TOKENS: Array<[string, number]> = [
  // OpenAI
  ['gpt-4.1', 1_047_576],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 8_192],
  ['gpt-3.5', 16_385],
  ['o1', 200_000],
  ['o3', 200_000],
  // Anthropic
  ['claude-opus-4', 200_000],
  ['claude-sonnet-4', 200_000],
  ['claude-3', 200_000],
  ['claude-', 200_000],
  // Google
  ['gemini-1.5-pro', 2_097_152],
  ['gemini-1.5', 1_048_576],
  ['gemini-2', 1_048_576],
  ['gemini-', 1_048_576],
  // xAI
  ['grok-4', 256_000],
  ['grok-3', 131_072],
  ['grok-', 131_072]
]

/** Used when neither the server nor the table knows the model. */
const PROVIDER_FALLBACK_TOKENS: Record<string, number> = {
  openai: 128_000,
  anthropic: 200_000,
  gemini: 1_048_576,
  grok: 131_072,
  // Local endpoints vary wildly and always report `n_ctx`; this only applies
  // before the first successful model listing.
  ollama: 32_768
}

const DEFAULT_CONTEXT_TOKENS = 32_768

/**
 * The model's context window in tokens.
 *
 * `discovered` is what the endpoint itself reported for this model — it wins,
 * always. A table cannot track a local server that is relaunched with a
 * different `-c`.
 */
export function resolveContextWindowTokens(
  provider: LLMProvider | string,
  model: string,
  discovered?: number
): number {
  if (discovered && discovered > 0) return discovered

  const name = (model || '').toLowerCase()
  let best: number | null = null
  let bestLen = -1
  for (const [prefix, tokens] of MODEL_CONTEXT_TOKENS) {
    if (name.includes(prefix) && prefix.length > bestLen) {
      best = tokens
      bestLen = prefix.length
    }
  }
  if (best !== null) return best

  return PROVIDER_FALLBACK_TOKENS[provider] ?? DEFAULT_CONTEXT_TOKENS
}

/**
 * Estimate tokens for text that may be mostly CJK.
 *
 * The `length / 4` rule used elsewhere in this codebase is an English rule. A
 * Chinese character is roughly one token, so a 40,000-character chapter is
 * ~40k tokens, not the ~10k that rule predicts — a four-fold underestimate on
 * exactly the content this app is written for. Counting the two scripts
 * separately keeps the budget honest for both.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length
  const rest = text.length - cjk
  return Math.ceil(cjk + rest / 4)
}

/** Inverse of `estimateTokens` for a mixed-script budget, used to size caps. */
export function tokensToChars(tokens: number, cjkRatio: number): number {
  const clamped = Math.min(1, Math.max(0, cjkRatio))
  const charsPerToken = clamped * 1 + (1 - clamped) * 4
  return Math.floor(tokens * charsPerToken)
}

export interface HistoryBudgetInput {
  contextTokens: number
  /** Tokens the reply may use — they must fit in the same window. */
  maxOutputTokens: number
  /** Everything this turn sends besides the history: system, ledger, tail. */
  fixedTokens: number
  /** Share of the conversation that is CJK, for the token→char conversion. */
  cjkRatio: number
}

/** Never let the window collapse to nothing, however tight the budget is. */
export const MIN_HISTORY_CHARS = 4_000

/**
 * Characters of chat history this turn may carry.
 *
 * A tenth of the window is held back: the estimates above are estimates, and
 * overrunning the window is far worse than trimming one turn early — the
 * provider either errors or silently drops the FRONT of the prompt, which is
 * the cached prefix.
 */
export function historyBudgetChars(input: HistoryBudgetInput): number {
  const { contextTokens, maxOutputTokens, fixedTokens, cjkRatio } = input
  const safety = Math.ceil(contextTokens * 0.1)
  const available = contextTokens - maxOutputTokens - fixedTokens - safety
  if (available <= 0) return MIN_HISTORY_CHARS
  return Math.max(MIN_HISTORY_CHARS, tokensToChars(available, cjkRatio))
}

/** Share of `text` that is CJK, for choosing a chars-per-token ratio. */
export function cjkRatioOf(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length
  return cjk / text.length
}
