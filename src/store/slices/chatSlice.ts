import type { StateCreator } from 'zustand'
import type { ChatMessage } from '../../types/chat'
import type { AppState } from '../types'

export interface ChatSlice {
  // Chat state
  messages: ChatMessage[]
  isStreaming: boolean
  addMessage: (message: ChatMessage) => void
  clearChat: () => void
  setStreaming: (isStreaming: boolean) => void
  setMessages: (messages: ChatMessage[]) => void

  // Session stats & local storage tracking
  sessionInputTokens: number
  sessionOutputTokens: number
  sessionCacheHitTokens: number
  sessionCacheMissTokens: number
  addSessionTokens: (input: number, output: number, cacheHit?: number) => void
  resetSessionTokens: () => void
}

export const createChatSlice: StateCreator<AppState, [], [], ChatSlice> = (set) => ({
  // Chat state
  messages: [
    {
      id: 'welcome',
      role: 'assistant',
      content: "Hello! I'm your Web Canvas assistant. You can write your document directly in the right panel, or tell me what you want to write and I can draft it for you. How can I help you today?",
      timestamp: new Date().toISOString(),
    },
  ],
  isStreaming: false,
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  clearChat: () =>
    set({
      messages: [
        {
          id: `welcome-${Date.now()}`,
          role: 'assistant',
          content: "Chat history cleared. How can I help you with your document?",
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  setStreaming: (isStreaming) => set({ isStreaming }),
  setMessages: (messages) => set({ messages }),

  // Session stats & local storage implementation
  sessionInputTokens: 0,
  sessionOutputTokens: 0,
  sessionCacheHitTokens: 0,
  sessionCacheMissTokens: 0,
  addSessionTokens: (input, output, cacheHit = 0) => set((state) => {
    // Clamp defensively: providers report input/cached tokens in different
    // shapes, and a mis-mapped extractor must never corrupt the counters
    // with a negative miss.
    const hit = Math.min(cacheHit, input)
    const miss = Math.max(0, input - hit)
    return {
      sessionInputTokens: state.sessionInputTokens + input,
      sessionOutputTokens: state.sessionOutputTokens + output,
      sessionCacheHitTokens: state.sessionCacheHitTokens + hit,
      sessionCacheMissTokens: state.sessionCacheMissTokens + miss,
    }
  }),
  resetSessionTokens: () => set({
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    sessionCacheHitTokens: 0,
    sessionCacheMissTokens: 0
  }),
})
