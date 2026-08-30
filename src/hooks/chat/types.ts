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

/**
 * Ledger eviction consent: the user's own selection would push chapters out of
 * the cached prefix, which costs a re-prefill of everything after them.
 * Rendered as an inline panel in ChatPanel (the same shape as the whole-book
 * cost panel) and awaited before the request is built.
 */
export interface LedgerConsentRequest {
  /** Titles the user's selection would drop. */
  droppedTitles: string[]
  /** Characters that would have to be prefilled again. */
  resendChars: number
  /** How many chapters that is. */
  resendChapters: number
}

/**
 * `remove` accepts the cost; `keep` holds the chapters in the ledger (they
 * stop being presented as selected but stay in the prefix); `cancel` abandons
 * the send.
 */
export type LedgerConsentChoice = 'remove' | 'keep' | 'cancel'
