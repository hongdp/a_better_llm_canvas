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
