/**
 * Shared interfaces for the chat orchestration hook (`useChatLLM`) and its
 * extracted helper modules under `src/hooks/chat/`.
 */

/** Minimal chat-message shape needed to build history for the LLM. */
export interface HistorySourceMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
}

