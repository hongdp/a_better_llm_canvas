import { create } from 'zustand'

export type LLMProvider = 'openai' | 'gemini' | 'anthropic' | 'ollama'

export interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl: string
  systemPrompt?: string
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

// TODO(security): Implement a Backend-for-Frontend (BFF) layer to store API keys
// in server-side HttpOnly cookies instead of exposing them to client-side JS.
const getCookie = (name: string): string => {
  if (typeof document === 'undefined') return ''
  const nameEQ = name + '='
  const ca = document.cookie.split(';')
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i]
    while (c.charAt(0) === ' ') c = c.substring(1, c.length)
    if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length))
  }
  return ''
}

const setCookie = (name: string, value: string, days = 365) => {
  if (typeof document === 'undefined') return
  let expires = ''
  if (days) {
    const date = new Date()
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000)
    expires = '; expires=' + date.toUTCString()
  }
  document.cookie = name + '=' + encodeURIComponent(value || '') + expires + '; path=/; SameSite=Lax; Secure'
}

const DEFAULT_CONFIGS: Record<LLMProvider, ProviderConfig> = {
  openai: {
    apiKey: '',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    systemPrompt: '',
  },
  gemini: {
    apiKey: '',
    model: 'gemini-1.5-pro',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    systemPrompt: '',
  },
  anthropic: {
    apiKey: '',
    model: 'claude-3-5-sonnet',
    baseUrl: 'https://api.anthropic.com/v1',
    systemPrompt: '',
  },
  ollama: {
    apiKey: 'ollama-no-key',
    model: 'llama3',
    baseUrl: 'http://localhost:11434/v1',
    systemPrompt: '',
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

const CURRENT_SETTINGS_VERSION = 1

interface VersionedCookieData<T> {
  version: number
  data: T
}

const saveConfigsToCookie = (configs: Record<LLMProvider, ProviderConfig>) => {
  const envelope: VersionedCookieData<Record<LLMProvider, ProviderConfig>> = {
    version: CURRENT_SETTINGS_VERSION,
    data: configs,
  }
  setCookie('__Secure-web_canvas_providers', JSON.stringify(envelope))
}

const migrateProvidersConfig = (savedString: string): Record<LLMProvider, ProviderConfig> => {
  try {
    const parsed = JSON.parse(savedString)
    
    // Case 1: Legacy unversioned structure (direct Record<LLMProvider, ProviderConfig>)
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
      console.log('Migrating legacy (v0) LLM configs to v1')
      const migratedData = { ...DEFAULT_CONFIGS }
      const rawData = parsed as any
      for (const p of Object.keys(DEFAULT_CONFIGS) as LLMProvider[]) {
        if (rawData && rawData[p]) {
          migratedData[p] = {
            ...DEFAULT_CONFIGS[p],
            ...rawData[p],
            systemPrompt: rawData[p].systemPrompt || '',
          }
        }
      }
      // Save versioned cookie immediately
      saveConfigsToCookie(migratedData)
      return migratedData
    }

    // Case 2: Versioned structure
    const versioned = parsed as VersionedCookieData<Record<LLMProvider, ProviderConfig>>
    let currentData = versioned.data
    let version = versioned.version

    // Run migrations step-by-step
    if (version < 1) {
      version = 1
    }
    
    // Save back if version was updated during migration
    if (version !== versioned.version) {
      saveConfigsToCookie(currentData)
    }

    // Ensure all required properties for all providers exist in returning data
    const merged = { ...DEFAULT_CONFIGS }
    for (const p of Object.keys(DEFAULT_CONFIGS) as LLMProvider[]) {
      if (currentData[p]) {
        merged[p] = {
          ...DEFAULT_CONFIGS[p],
          ...currentData[p],
        }
      }
    }
    return merged
  } catch (e) {
    console.error('Failed to parse and migrate saved configs, resetting to default', e)
    return DEFAULT_CONFIGS
  }
}

// Load initial configs and documents from cookies/localStorage
const loadSavedConfigs = (): Record<LLMProvider, ProviderConfig> => {
  const saved = getCookie('__Secure-web_canvas_providers')
  if (saved) {
    return migrateProvidersConfig(saved)
  }
  return DEFAULT_CONFIGS
}

const loadSavedProvider = (): LLMProvider => {
  const saved = getCookie('__Secure-web_canvas_active_provider')
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
    theme: (getCookie('__Secure-web_canvas_theme') as 'dark' | 'light') || 'dark',
    setTheme: (theme) => {
      setCookie('__Secure-web_canvas_theme', theme)
      set({ theme })
    },

    // Multi-document state
    documents: initialDocs,
    activeDocumentId: initialActiveId,
    isSidebarOpen: getCookie('__Secure-web_canvas_sidebar_open') !== 'false',
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
        setCookie('__Secure-web_canvas_sidebar_open', String(isOpen))
        return { isSidebarOpen: isOpen }
      })
    },

    // LLM configurations
    activeProvider: loadSavedProvider(),
    providerConfigs: loadSavedConfigs(),
    availableGeminiModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash-8b'],
    setProvider: (provider) => {
      setCookie('__Secure-web_canvas_active_provider', provider)
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
        saveConfigsToCookie(updatedConfigs)
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
