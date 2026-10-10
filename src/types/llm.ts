import type { ReasoningEffort } from '../utils/reasoningEffort'
import type { DocumentProtocol } from '../utils/protocolChoice'
export type LLMProvider = 'openai' | 'gemini' | 'anthropic' | 'ollama' | 'runpod' | 'grok'

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
   * Offer the read/navigate tools — the agentic loop
   * (docs/features/agentic_chat_loop.md). Absent = on. Off = one step per
   * turn plus the corrective retries, the pre-loop behaviour.
   */
  agentTools?: boolean
  /** Steps one turn may take; 0 = no limit. Absent = the provider default (agent/policy). */
  agentMaxSteps?: number
  /**
   * Hand the result of writes that all succeeded back to the model, which
   * keeps working or ends with a reply that has no action (spec D3). Off: a
   * write-only reply ends the turn. Absent = the default (on).
   */
  continueAfterWrites?: boolean
  /**
   * The model the polish pass uses (D9), same provider. Absent = the
   * provider default (agent/polish defaultPolishModel).
   */
  polishModel?: string
  /**
   * Run chat turns on the server (backend_authority.md §4.3): the loop, the
   * tools and the document writes happen in the API process, so a turn
   * survives a reload, a closed tab and an API restart, and a request sent
   * mid-turn queues. Absent = off: the turn runs in this tab as before.
   */
  serverRuns?: boolean
  /**
   * Server runs only: prompt + completion tokens one run may spend before it
   * is paused for the user to look at (0 or absent = no budget).
   */
  runTokenBudget?: number
  /**
   * Hidden reasoning tokens in one step that wrote nothing, past which the
   * step after next is told to act instead of think (agent/reminders).
   * Only where the provider reports reasoning tokens (grok). 0 or absent = off.
   */
  longReasoningReminderTokens?: number
  /**
   * web_search / web_read through the server's headless browser
   * (attachments_and_web.md §2). Absent = on; offered only when the server
   * has a browser.
   */
  webAccess?: boolean
  /**
   * Per request, not a setting: 'none' forbids new tool calls while keeping
   * the tools in the request (the agentic run's final step).
   */
  toolChoice?: 'auto' | 'none'
  /**
   * Document tools in OpenAI shape (see utils/documentTools). Present for any
   * provider that supports tool calling; adapters translate at the edge.
   * Absent on the markup protocol — the tags are the interface there.
   */
  tools?: unknown[]
}

/**
 * A tool call as the model made it, kept for replay in a later step of the
 * same turn (docs/features/agentic_chat_loop.md §5.5).
 */
export interface LLMToolCall {
  id: string
  name: string
  /**
   * The arguments EXACTLY as received. Never re-serialize parsed JSON into
   * this: grok's prompt cache is exact-prefix, so a re-spaced replay turns
   * every follow-up step into a full-price prefill.
   */
  argumentsText: string
  /**
   * Gemini's `thoughtSignature` from this call's part, replayed on the same
   * part. Gemini 3 rejects (400) a step whose first call comes back without
   * it; only the FIRST of parallel calls carries one, so most calls have none.
   * Opaque — never inspect or rebuild it.
   */
  signature?: string
}

/**
 * Anthropic reasoning blocks, kept verbatim for replay. With extended
 * thinking on, the assistant turn that holds `tool_use` must come back with
 * these blocks complete, unmodified and in their original order, or the next
 * step is rejected (400). `thinking` may be '' (display: "omitted") — the
 * `signature` is what the API checks. `redacted_thinking` has no text at all.
 */
export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant only: the tool calls this reply made. */
  toolCalls?: LLMToolCall[]
  /** Tool only: the call this message answers. */
  toolCallId?: string
  /** Tool only: the tool's name (Gemini keys results by name, not id). */
  name?: string
  /**
   * Assistant only, Anthropic: the reasoning blocks this reply streamed, in
   * order. Replayed BEFORE the text and tool_use blocks (providerMessages).
   */
  thinking?: ThinkingBlock[]
  /**
   * Assistant only, grok (xAI Responses API): this reply's output items
   * exactly as returned — reasoning (with its encrypted_content), message,
   * function_call — in order. The next step of the same turn sends them back
   * unchanged, so the model keeps its reasoning (providerMessages
   * toGrokResponsesInput). Opaque: never inspect or rebuild them. A history
   * message carries only the reasoning items of its turn; the converter then
   * adds the message's text after them.
   */
  responseItems?: unknown[]
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
/** What a step cost. `reasoningTokens` only where the provider reports it (grok's Responses API). */
export interface StreamUsage {
  promptTokens: number
  completionTokens: number
  cachedPromptTokens?: number
  reasoningTokens?: number
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void
  onDone: (fullText: string, usage?: StreamUsage) => void
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
    /** Gemini thoughtSignature of this call's part, when the provider sent one. */
    signature?: string
  }) => void
  /**
   * One COMPLETED Anthropic reasoning block (thinking with its signature, or
   * redacted_thinking), in stream order — keep them for the replay
   * (LLMMessage.thinking). A transport delivers each block once per attach;
   * a fresh resume of a remote job replays every block from the start.
   */
  onThinkingBlock?: (block: ThinkingBlock) => void
  /**
   * One COMPLETED grok output item (xAI Responses API), in stream order —
   * keep them for the next step (LLMMessage.responseItems). Delivered once
   * per attach, like thinking blocks.
   */
  onResponseItem?: (item: unknown) => void
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
  // Shown only until the endpoint answers /models. These are the aliases
  // llama.cpp's router derives from the model directory names in
  // scripts/cloud_endpoint — a live listing replaces them.
  runpod: ['qwen3.8-IQ4_XS', 'qwen3.8-IQ3_XXS', 'qwen3.8-Q4_K_M'],
  grok: ['grok-4.3', 'grok-build-0.1', 'grok-3', 'grok-2', 'grok-2-vision', 'grok-beta']
}
