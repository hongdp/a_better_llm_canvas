/**
 * Reasoning ("thinking") effort: what the user picks, and what each provider
 * wants to hear.
 *
 * Why this exists: a reasoning model can spend minutes thinking before its
 * first visible token — measured at 127s, 187s and 199s on grok-4.6 with a
 * 42k-char prompt, all of it reasoning (8,648 chars of it in one turn). The
 * effort level is the only lever that shortens that, and every provider spells
 * it differently.
 *
 * There is no capability API to ask. xAI's /language-models returns pricing
 * and modalities and nothing about reasoning; OpenAI's and Anthropic's model
 * lists are equally silent. So the supported levels live in the table below,
 * and anything the table gets wrong shows up as the provider's own error on
 * that request.
 */

/** Normalized levels. 'default' means "send nothing, let the provider decide". */
export const REASONING_EFFORTS = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

interface ModelReasoningSupport {
  /** Matches the model id (case-insensitive substring or regex). */
  match: RegExp
  /** Levels this model family accepts, in ascending order of effort. */
  levels: ReasoningEffort[]
}

/**
 * Per-provider capability table, first match wins.
 *
 * Sources: xAI's reasoning docs (grok-4.6 takes low/medium/high/xhigh and
 * cannot disable reasoning; grok-4.5 has no xhigh; grok-3-mini is low/high),
 * and OpenAI's reasoning_effort on the o-series and gpt-5 families.
 * Anthropic and Gemini express effort as a token BUDGET rather than a word,
 * so their levels map to numbers in the request builders below.
 *
 * Probed against api.x.ai on 2026-10-05, one tiny request per level:
 * grok-4.7 and grok-4.3 accept every level, so they get grok-4.6's set.
 * grok-4.20-0309-reasoning rejects the parameter outright ("does not support
 * parameter reasoningEffort") — listing levels for it only bought a failed
 * request and a retry on every turn, so it offers 'default' alone.
 * grok-4.5 also accepted xhigh, but spent exactly the reasoning tokens of
 * high, so xhigh looks silently clamped there and stays unlisted.
 */
const SUPPORT_TABLE: Record<string, ModelReasoningSupport[]> = {
  grok: [
    // First, so no broader grok-4 pattern added later can claim it.
    { match: /grok-4\.20/i, levels: ['default'] },
    { match: /grok-4\.(?:3|6|7)(?!\d)/i, levels: ['default', 'low', 'medium', 'high', 'xhigh'] },
    { match: /grok-4\.5/i, levels: ['default', 'low', 'medium', 'high'] },
    { match: /grok-3-mini/i, levels: ['default', 'low', 'high'] }
  ],
  openai: [
    { match: /^(?:o[1-9]|gpt-5)/i, levels: ['default', 'minimal', 'low', 'medium', 'high'] }
  ],
  anthropic: [
    // Extended thinking: a token budget, mapped in buildAnthropicThinking.
    { match: /claude-(?:3-7|opus-4|sonnet-4|haiku-4|opus-5|sonnet-5|fable-5)/i, levels: ['default', 'low', 'medium', 'high'] }
  ],
  gemini: [
    { match: /gemini-2\.5|gemini-3/i, levels: ['default', 'minimal', 'low', 'medium', 'high'] }
  ],
  ollama: [],
  // llama.cpp takes --reasoning as a server flag, not a per-request field.
  runpod: []
}

/**
 * Levels the UI should offer for this provider/model. Always at least
 * ['default'] — an unknown model is not assumed to support anything.
 */
export function supportedReasoningEfforts(provider: string, model: string): ReasoningEffort[] {
  const entries = SUPPORT_TABLE[provider] ?? []
  const hit = entries.find(e => e.match.test(model || ''))
  return hit ? hit.levels : ['default']
}

/** Would this provider/model do anything with an effort setting at all? */
export function supportsReasoningEffort(provider: string, model: string): boolean {
  return supportedReasoningEfforts(provider, model).length > 1
}

/**
 * This app's default when the user has never chosen: LOW, not the provider's.
 *
 * grok-4.6 defaults to 'high' and spent 127-199s thinking before its first
 * visible token on a normal chapter edit. For document editing that trade is
 * wrong — the user is waiting, watching an empty page. Anyone who wants the
 * deeper pass can pick it, and 'default' (send nothing) remains available.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low'

/**
 * The effort actually worth sending. Note the two distinct "nothing chosen"
 * cases: `undefined` means the user never touched the setting and gets this
 * app's default, while an explicit 'default' means "let the provider decide"
 * and sends no parameter at all. Anything the model does not accept collapses
 * to null.
 */
export function resolveReasoningEffort(
  provider: string,
  model: string,
  effort: ReasoningEffort | undefined
): Exclude<ReasoningEffort, 'default'> | null {
  const chosen = effort ?? DEFAULT_REASONING_EFFORT
  if (chosen === 'default') return null
  const effort_ = chosen
  return supportedReasoningEfforts(provider, model).includes(effort_)
    ? (effort_ as Exclude<ReasoningEffort, 'default'>)
    : null
}

/**
 * Thinking budgets for the providers that take a number instead of a word.
 * Anthropic requires budget < max_tokens; Gemini treats 0 as off and -1 as
 * dynamic. These are deliberately modest — the point of the setting is to stop
 * a model from thinking for three minutes.
 */
const THINKING_BUDGET_TOKENS: Record<Exclude<ReasoningEffort, 'default'>, number> = {
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768
}

export function reasoningBudgetTokens(effort: Exclude<ReasoningEffort, 'default'>): number {
  return THINKING_BUDGET_TOKENS[effort]
}
