/**
 * Shared interfaces for the chat orchestration hook (`useChatLLM`) and its
 * extracted helper modules under `src/hooks/chat/`.
 */
import type { LLMMessage } from '../../types/llm'

// State threaded through the agentic lookup loop so a continuation round can
// rebuild the SAME request with more chapters attached. `prefixMessages`
// (system + windowed history) is reused verbatim — the retry only changes the
// final user message, keeping the provider prompt-cache prefix intact.
export interface LookupLoopContext {
  promptText: string
  images?: string[]
  prefixMessages: LLMMessage[]
  attachedIds: string[]
  autoIds: string[]
  round: number
}

/** Minimal chat-message shape needed to build history for the LLM. */
export interface HistorySourceMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
}
