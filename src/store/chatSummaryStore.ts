/**
 * A tab's copy of the conversation summary, per book
 * (docs/features/agentic_chat_loop.md §0.9). Light enough for localStorage;
 * a versioned envelope like every persisted structure. The server keeps its
 * own copy per book (server_context, scope `chat-summary`).
 */
import type { StoredSummary } from '../utils/conversationSummary'
import { localStorage } from './persistence'

export const CHAT_SUMMARY_VERSION = 1
const keyOf = (bookId: string) => `wc:chat-summary:${bookId}`

export function loadChatSummary(bookId: string): StoredSummary | null {
  const raw = localStorage.getItem(keyOf(bookId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { version?: number; data?: { upToId?: unknown; text?: unknown } }
    if (parsed?.version !== CHAT_SUMMARY_VERSION) return null
    const { upToId, text } = parsed.data ?? {}
    return typeof upToId === 'string' && typeof text === 'string' && text.trim() ? { upToId, text } : null
  } catch {
    return null
  }
}

export function saveChatSummary(bookId: string, summary: StoredSummary): void {
  localStorage.setItem(keyOf(bookId), JSON.stringify({ version: CHAT_SUMMARY_VERSION, data: summary }))
}

export function clearChatSummary(bookId: string): void {
  localStorage.removeItem(keyOf(bookId))
}
