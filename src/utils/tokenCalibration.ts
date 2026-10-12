/**
 * How far the provider's token count departs from this app's estimate, per
 * provider and model — measured on every finished run and applied to the
 * next turn's history budget.
 *
 * Problem: `estimateTokens` counts a CJK character as one token and four Latin
 *   characters as one. Sonnet 5.5 counted a 293k-character request at 333k
 *   tokens (1.14 per character): the history budget, sized from the estimate,
 *   admitted a third more than it meant to, and with the old 200k window
 *   figure the run then elided a read result every step (2026-10-11). A run
 *   already calibrates its own compaction from the last step's usage
 *   (runCompaction.calibratedPromptTokens); the budget at the start of the
 *   next turn did not.
 * Fix: remember measured ÷ estimated for the provider|model of each finished
 *   run, and size the next turn's budget in estimated tokens by dividing the
 *   window by it. Kept in localStorage so a reload starts calibrated.
 */

/**
 * The ratio only ever shrinks the budget: a provider that counts fewer tokens
 * than the estimate costs some history, one that counts more overruns the
 * window — so below 1 is taken as 1. Above 3 the measurement is more likely
 * wrong than the estimate.
 */
export const RATIO_MIN = 1
export const RATIO_MAX = 3

export const TOKEN_RATIO_KEY = 'web_canvas_token_ratio_v1'

export const calibrationKey = (provider: string, model: string): string => `${provider}|${model}`

export const clampRatio = (ratio: number): number => Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio))

/** measured ÷ estimated, or null when either side is missing. */
export function tokenRatio(measuredTokens: number | null | undefined, estimatedTokens: number): number | null {
  if (!measuredTokens || !(measuredTokens > 0) || !(estimatedTokens > 0)) return null
  return clampRatio(measuredTokens / estimatedTokens)
}

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function loadTokenRatios(store: Store | null | undefined): Record<string, number> {
  try {
    const raw = store?.getItem(TOKEN_RATIO_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : null
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampRatio(v)
    }
    return out
  } catch {
    return {}
  }
}

export function saveTokenRatios(store: Store | null | undefined, ratios: Record<string, number>): void {
  try {
    store?.setItem(TOKEN_RATIO_KEY, JSON.stringify(ratios))
  } catch {
    // Storage full or blocked: the ratio lives in memory for this tab.
  }
}
