import { create } from 'zustand'

export type LLMProvider = 'openai' | 'gemini' | 'anthropic' | 'ollama'

export interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface CanvasDocument {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
}

interface AppState {
  // Theme state
  theme: 'dark' | 'light'
  setTheme: (theme: 'dark' | 'light') => void

  // Multi-document state
  documents: CanvasDocument[]
  activeDocumentId: string
  isSidebarOpen: boolean
  selectedReferenceIds: string[]
  
  setActiveDocumentId: (id: string) => void
  addDocument: (title?: string, content?: string) => string
  deleteDocument: (id: string) => void
  updateActiveDocument: (updates: Partial<CanvasDocument>) => void
  toggleReference: (id: string) => void
  clearReferences: () => void
  toggleSidebar: () => void

  // LLM configurations
  activeProvider: LLMProvider
  providerConfigs: Record<LLMProvider, ProviderConfig>
  setProvider: (provider: LLMProvider) => void
  updateProviderConfig: (provider: LLMProvider, config: Partial<ProviderConfig>) => void
  availableGeminiModels: string[]
  setAvailableGeminiModels: (models: string[]) => void

  // Chat state
  messages: ChatMessage[]
  isStreaming: boolean
  addMessage: (message: ChatMessage) => void
  clearChat: () => void
  setStreaming: (isStreaming: boolean) => void
  setMessages: (messages: ChatMessage[]) => void
}

const DEFAULT_CONFIGS: Record<LLMProvider, ProviderConfig> = {
  openai: {
    apiKey: '',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
  },
  gemini: {
    apiKey: '',
    model: 'gemini-1.5-pro',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  anthropic: {
    apiKey: '',
    model: 'claude-3-5-sonnet',
    baseUrl: 'https://api.anthropic.com/v1',
  },
  ollama: {
    apiKey: 'ollama-no-key',
    model: 'llama3',
    baseUrl: 'http://localhost:11434/v1',
  },
}

const MOCK_DOCUMENTS: CanvasDocument[] = [
  {
    id: 'doc-1',
    title: 'Chapter 1: Introduction',
    content: `<h1>Getting Started with Web Canvas</h1>
<p>Welcome to <strong>Web Canvas</strong>! This is an LLM-powered environment designed for writing and document collaboration.</p>
<p>You can manage your chapters in the Chapters Sidebar on the left-most side of the screen.</p>
<p>Toggle references using the tags below the chat box to include other chapters in Gemini's context!</p>`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'doc-2',
    title: 'Chapter 2: Setup Guide',
    content: `<h1>Setup and Config</h1>
<p>This is Chapter 2. You can toggle it as a reference under the chat box so that Gemini can see its content while you edit another chapter.</p>
<p>Make sure to enter your API key in the settings panel first.</p>`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

// Load initial configs and documents from localStorage
const loadSavedConfigs = (): Record<LLMProvider, ProviderConfig> => {
  const saved = localStorage.getItem('web_canvas_providers')
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      const merged = { ...DEFAULT_CONFIGS }
      for (const p of Object.keys(DEFAULT_CONFIGS) as LLMProvider[]) {
        if (parsed[p]) {
          merged[p] = { ...DEFAULT_CONFIGS[p], ...parsed[p] }
        }
      }
      return merged
    } catch (e) {
      console.error('Failed to parse saved LLM configurations', e)
    }
  }
  return DEFAULT_CONFIGS
}

const loadSavedProvider = (): LLMProvider => {
  const saved = localStorage.getItem('web_canvas_active_provider')
  if (saved && ['openai', 'gemini', 'anthropic', 'ollama'].includes(saved)) {
    return saved as LLMProvider
  }
  return 'gemini'
}

const loadSavedDocuments = (): CanvasDocument[] => {
  const saved = localStorage.getItem('web_canvas_documents')
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
      }
    } catch (e) {
      console.error('Failed to parse saved documents', e)
    }
  }
  return MOCK_DOCUMENTS
}

const loadSavedActiveDocId = (docs: CanvasDocument[]): string => {
  const saved = localStorage.getItem('web_canvas_active_document_id')
  if (saved && docs.some((d) => d.id === saved)) {
    return saved
  }
  return docs[0]?.id || ''
}

export const useAppStore = create<AppState>((set) => {
  const initialDocs = loadSavedDocuments()
  const initialActiveId = loadSavedActiveDocId(initialDocs)

  return {
    // Theme state
    theme: (localStorage.getItem('web_canvas_theme') as 'dark' | 'light') || 'dark',
    setTheme: (theme) => {
      localStorage.setItem('web_canvas_theme', theme)
      set({ theme })
    },

    // Multi-document state
    documents: initialDocs,
    activeDocumentId: initialActiveId,
    isSidebarOpen: localStorage.getItem('web_canvas_sidebar_open') !== 'false',
    selectedReferenceIds: [],

    setActiveDocumentId: (id) => {
      localStorage.setItem('web_canvas_active_document_id', id)
      set({ activeDocumentId: id })
    },

    addDocument: (title = 'New Chapter', content = '<p>Start writing...</p>') => {
      const newDoc: CanvasDocument = {
        id: `doc-${Date.now()}`,
        title,
        content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      let docId = ''

      set((state) => {
        const updatedDocs = [...state.documents, newDoc]
        localStorage.setItem('web_canvas_documents', JSON.stringify(updatedDocs))
        localStorage.setItem('web_canvas_active_document_id', newDoc.id)
        docId = newDoc.id
        return { 
          documents: updatedDocs,
          activeDocumentId: newDoc.id
        }
      })
      return docId
    },

    deleteDocument: (id) => {
      set((state) => {
        const filteredDocs = state.documents.filter((d) => d.id !== id)
        
        let newActiveId = state.activeDocumentId
        if (state.activeDocumentId === id) {
          newActiveId = filteredDocs[0]?.id || ''
        }

        // If all docs are deleted, add a fresh fallback doc
        if (filteredDocs.length === 0) {
          const fallbackDoc: CanvasDocument = {
            id: `doc-${Date.now()}`,
            title: 'Chapter 1: Welcome',
            content: '<h1>Getting Started</h1><p>Start writing...</p>',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          filteredDocs.push(fallbackDoc)
          newActiveId = fallbackDoc.id
        }

        localStorage.setItem('web_canvas_documents', JSON.stringify(filteredDocs))
        localStorage.setItem('web_canvas_active_document_id', newActiveId)

        return {
          documents: filteredDocs,
          activeDocumentId: newActiveId,
          // Remove from selected reference list if present
          selectedReferenceIds: state.selectedReferenceIds.filter((refId) => refId !== id)
        }
      })
    },

    updateActiveDocument: (updates) => {
      set((state) => {
        const updatedDocs = state.documents.map((d) => {
          if (d.id === state.activeDocumentId) {
            return {
              ...d,
              ...updates,
              updatedAt: new Date().toISOString(),
            }
          }
          return d
        })
        localStorage.setItem('web_canvas_documents', JSON.stringify(updatedDocs))
        return { documents: updatedDocs }
      })
    },

    toggleReference: (id) => {
      set((state) => {
        const refs = state.selectedReferenceIds.includes(id)
          ? state.selectedReferenceIds.filter((refId) => refId !== id)
          : [...state.selectedReferenceIds, id]
        return { selectedReferenceIds: refs }
      })
    },

    clearReferences: () => set({ selectedReferenceIds: [] }),

    toggleSidebar: () => {
      set((state) => {
        const isOpen = !state.isSidebarOpen
        localStorage.setItem('web_canvas_sidebar_open', String(isOpen))
        return { isSidebarOpen: isOpen }
      })
    },

    // LLM configurations
    activeProvider: loadSavedProvider(),
    providerConfigs: loadSavedConfigs(),
    availableGeminiModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash-8b'],
    setProvider: (provider) => {
      localStorage.setItem('web_canvas_active_provider', provider)
      set({ activeProvider: provider })
    },
    setAvailableGeminiModels: (models) => {
      set({ availableGeminiModels: models })
    },
    updateProviderConfig: (provider, newConfig) => {
      set((state) => {
        const updatedConfigs = {
          ...state.providerConfigs,
          [provider]: {
            ...state.providerConfigs[provider],
            ...newConfig,
          },
        }
        localStorage.setItem('web_canvas_providers', JSON.stringify(updatedConfigs))
        return { providerConfigs: updatedConfigs }
      })
    },

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
  }
})
