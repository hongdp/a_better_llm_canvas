import type { ReasoningEffort } from '../utils/reasoningEffort'
import type { DocumentProtocol } from '../utils/protocolChoice'
export type LLMProvider = 'openai' | 'gemini' | 'anthropic' | 'ollama' | 'grok'

export interface GeminiSafetySetting {
  category: string
  threshold: string
}

export interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl: string
  systemPrompt?: string
  geminiSafetySettings?: GeminiSafetySetting[]
  maxOutputTokens?: number
  /**
   * Cheap "utility" model for background chapter summaries (Flash/Haiku
   * class). Empty/absent = use the main chat `model`.
   */
  summaryModel?: string
  /**
   * How hard the model should think before answering. Absent = this app's
   * default (low — see DEFAULT_REASONING_EFFORT); 'default' = send nothing and
   * let the provider choose. Silently ignored by models that have no such
   * control.
   */
  reasoningEffort?: ReasoningEffort
  /**
   * How this model is asked to change the document: native tool calls, or the
   * Canvas tag markup. Absent = 'auto', which picks per provider from measured
   * streaming behaviour (see utils/protocolChoice). Bound to the provider
   * config, so switching models switches protocol with it.
   */
  documentProtocol?: DocumentProtocol
  /**
   * Document tools in OpenAI shape (see utils/documentTools). Present for any
   * provider that supports tool calling; adapters translate at the edge.
   * Absent on the markup protocol — the tags are the interface there.
   */
  tools?: unknown[]
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: string[] // base64 Data URLs
  /**
   * Marks the end of a stable prompt prefix for providers with explicit
   * prompt caching (Anthropic cache_control). Set on the last history
   * message — everything up to and including it is cacheable across turns,
   * while the volatile document context after it changes every request.
   */
  cacheHint?: boolean
}

/**
 * Callbacks a transport drives while a generation runs.
 *
 * WRAPPING THESE: spread the original first — `{ ...callbacks, onChunk: … }`.
 * Rebuilding the object field by field silently drops every optional callback,
 * which has already happened twice: `streamLLM`'s debug wrapper swallowed
 * onReasoning/onAttached, and the rejoin path swallowed onToolCallDelta, each
 * time producing a generation that streamed correctly and changed nothing.
 * The compiler cannot catch it — every field here except three is optional.
 */
export interface StreamCallbacks {
  onChunk: (chunk: string) => void
  onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }) => void
  onError: (error: Error) => void
  /**
   * The transport is connected but the model has produced nothing yet.
   * Optional: only the remote transport can distinguish this state, and only
   * some callers care (the chat bubble shows the wait instead of dead air).
   */
  onAttached?: () => void
  /**
   * A reasoning delta — the model's thinking, not document text. Optional:
   * only reasoning models produce it, and it is never part of the reply.
   */
  onReasoning?: (text: string) => void
  /**
   * A tool-call argument delta, forwarded as it arrives so the document
   * preview can render a partially-written `html` argument. `index`
   * distinguishes parallel calls.
   */
  onToolCallDelta?: (delta: {
    index: number
    id?: string
    name?: string
    argumentsText: string
    /** True when this carries the WHOLE call (a replay), not a fragment. */
    replace?: boolean
  }) => void
}

export type ImageGenProvider = 'openai' | 'gemini' | 'stabilityai' | 'grok'

export interface ImageGenConfig {
  provider: ImageGenProvider
  apiKey: string
  model?: string
  baseUrl?: string
  styleSystemPrompt?: string
  llmEnhancementEnabled?: boolean
}

export interface SystemPromptTemplate {
  id: string
  name: string
  content: string
}

export const PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash-8b'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o1-preview', 'o1-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  anthropic: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
  ollama: ['llama3', 'mistral', 'gemma2', 'codegemma', 'phi3'],
  grok: ['grok-4.3', 'grok-build-0.1', 'grok-3', 'grok-2', 'grok-2-vision', 'grok-beta']
}
