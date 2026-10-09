/** The tab's copy of the conversation summary: a versioned envelope per book. */
import { describe, it, expect, beforeEach } from 'vitest'
import { loadChatSummary, saveChatSummary, clearChatSummary, CHAT_SUMMARY_VERSION } from '../chatSummaryStore'
import { localStorage } from '../persistence'

beforeEach(() => { localStorage.clear() })

describe('chatSummaryStore', () => {
  it('round-trips a note per book', () => {
    saveChatSummary('book-1', { upToId: 'u6', text: 'NOTE' })
    expect(loadChatSummary('book-1')).toEqual({ upToId: 'u6', text: 'NOTE' })
    expect(loadChatSummary('book-2')).toBeNull()
    clearChatSummary('book-1')
    expect(loadChatSummary('book-1')).toBeNull()
  })

  it('ignores a foreign version, a broken payload and an empty note', () => {
    localStorage.setItem('wc:chat-summary:book-1', JSON.stringify({ version: CHAT_SUMMARY_VERSION + 1, data: { upToId: 'u', text: 'x' } }))
    expect(loadChatSummary('book-1')).toBeNull()
    localStorage.setItem('wc:chat-summary:book-1', '{not json')
    expect(loadChatSummary('book-1')).toBeNull()
    localStorage.setItem('wc:chat-summary:book-1', JSON.stringify({ version: CHAT_SUMMARY_VERSION, data: { upToId: 'u', text: '  ' } }))
    expect(loadChatSummary('book-1')).toBeNull()
  })
})
