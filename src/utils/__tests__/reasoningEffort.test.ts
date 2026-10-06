import { describe, it, expect } from 'vitest'
import {
  supportedReasoningEfforts,
  supportsReasoningEffort,
  resolveReasoningEffort,
  reasoningBudgetTokens,
  isReasoningEffortRejection,
  DEFAULT_REASONING_EFFORT
} from '../reasoningEffort'

describe('supportedReasoningEfforts', () => {
  it('follows the provider docs per model family', () => {
    // xAI: grok-4.6 adds xhigh, grok-4.5 does not, grok-3-mini has no medium.
    expect(supportedReasoningEfforts('grok', 'grok-4.6')).toEqual(['default', 'low', 'medium', 'high', 'xhigh'])
    expect(supportedReasoningEfforts('grok', 'grok-4.5')).toEqual(['default', 'low', 'medium', 'high'])
    expect(supportedReasoningEfforts('grok', 'grok-3-mini')).toEqual(['default', 'low', 'high'])
  })

  it('follows what api.x.ai actually accepted when probed (2026-10-05)', () => {
    // grok-4.7 and grok-4.3 took every level; they were missing from the
    // table, so the UI offered only the provider default for them.
    expect(supportedReasoningEfforts('grok', 'grok-4.7')).toEqual(['default', 'low', 'medium', 'high', 'xhigh'])
    expect(supportedReasoningEfforts('grok', 'grok-4.3')).toEqual(['default', 'low', 'medium', 'high', 'xhigh'])
    expect(supportedReasoningEfforts('grok', 'grok-4.3-latest')).toEqual(['default', 'low', 'medium', 'high', 'xhigh'])
    // grok-4.20 rejects the parameter, so offering levels only cost a 400
    // and a retry per turn. Every 4.20 id shares that, whatever its suffix.
    expect(supportedReasoningEfforts('grok', 'grok-4.20-0309-reasoning')).toEqual(['default'])
    expect(supportedReasoningEfforts('grok', 'grok-4.20')).toEqual(['default'])
    expect(resolveReasoningEffort('grok', 'grok-4.20-0309-reasoning', 'high')).toBeNull()
    // A two-digit minor must not be mistaken for its first digit.
    expect(supportedReasoningEfforts('grok', 'grok-4.35')).toEqual(['default'])
  })

  it('offers nothing but the provider default for a model with no such control', () => {
    // An unknown model is not assumed to accept the parameter — sending it
    // would 400 a turn for a setting the user cannot benefit from.
    expect(supportedReasoningEfforts('grok', 'grok-2-1212')).toEqual(['default'])
    expect(supportedReasoningEfforts('openai', 'gpt-4o')).toEqual(['default'])
    expect(supportedReasoningEfforts('ollama', 'llama3')).toEqual(['default'])
    expect(supportedReasoningEfforts('made-up', 'whatever')).toEqual(['default'])
  })

  it('knows which models can be adjusted at all', () => {
    expect(supportsReasoningEffort('grok', 'grok-4.6')).toBe(true)
    expect(supportsReasoningEffort('openai', 'o3-mini')).toBe(true)
    expect(supportsReasoningEffort('openai', 'gpt-4o')).toBe(false)
  })
})

describe('resolveReasoningEffort', () => {
  it('defaults to this app, not the provider', () => {
    // grok-4.6 defaults to 'high' and spent minutes thinking before its first
    // visible token; for document editing that trade is wrong.
    expect(DEFAULT_REASONING_EFFORT).toBe('low')
    expect(resolveReasoningEffort('grok', 'grok-4.6', undefined)).toBe('low')
  })

  it('sends nothing when the user explicitly picks the provider default', () => {
    expect(resolveReasoningEffort('grok', 'grok-4.6', 'default')).toBeNull()
  })

  it('passes a level the model accepts', () => {
    expect(resolveReasoningEffort('grok', 'grok-4.6', 'xhigh')).toBe('xhigh')
    expect(resolveReasoningEffort('openai', 'o3', 'minimal')).toBe('minimal')
  })

  it('drops a level the model does not accept rather than risk a 400', () => {
    expect(resolveReasoningEffort('grok', 'grok-4.5', 'xhigh')).toBeNull()
    expect(resolveReasoningEffort('grok', 'grok-3-mini', 'medium')).toBeNull()
    // Including the app default, on a model with no reasoning control at all.
    expect(resolveReasoningEffort('openai', 'gpt-4o', undefined)).toBeNull()
    expect(resolveReasoningEffort('ollama', 'llama3', 'low')).toBeNull()
  })
})

describe('reasoningBudgetTokens', () => {
  it('rises with the level', () => {
    const budgets = (['minimal', 'low', 'medium', 'high', 'xhigh'] as const).map(reasoningBudgetTokens)
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b))
    // Anthropic rejects a budget below 1024, so 'low' must clear it.
    expect(reasoningBudgetTokens('low')).toBeGreaterThanOrEqual(1024)
  })
})

describe('isReasoningEffortRejection', () => {
  it('recognises a provider refusing the parameter', () => {
    for (const msg of [
      'Unsupported parameter: reasoning_effort',
      '{"error":"reasoning_effort is not supported for this model"}',
      'Unknown field: thinking',
      'invalid value for reasoning_effort',
      // api.x.ai's wording for grok-4.20, observed 2026-10-05
      '{"code":"invalid-argument","error":"Model grok-4.20-0309-reasoning does not support parameter reasoningEffort."}'
    ]) expect(isReasoningEffortRejection(msg), msg).toBe(true)
  })

  it('does not swallow unrelated failures', () => {
    // Dropping the parameter and retrying must not become a blanket retry:
    // these errors would still fail the second time.
    for (const msg of [
      'Incorrect API key provided.',
      '429 rate limit exceeded',
      'context length exceeded: 300000 tokens',
      ''
    ]) expect(isReasoningEffortRejection(msg), msg).toBe(false)
  })
})
