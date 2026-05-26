import { create } from 'zustand'

export type LLMProvider = 'openai' | 'gemini' | 'anthropic' | 'ollama'

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
}

export interface SystemPromptTemplate {
  id: string
  name: string
  content: string
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
  debugMode: boolean
  setDebugMode: (enabled: boolean) => void

  // System prompts list
  customSystemPrompts: SystemPromptTemplate[]
  activeSystemPromptId: string
  setActiveSystemPromptId: (id: string) => void
  addSystemPrompt: (name?: string, content?: string) => string
  updateSystemPrompt: (id: string, updates: Partial<SystemPromptTemplate>) => void
  deleteSystemPrompt: (id: string) => void

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
    maxOutputTokens: 16384,
  },
  gemini: {
    apiKey: '',
    model: 'gemini-1.5-pro',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    geminiSafetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
    maxOutputTokens: 16384,
  },
  anthropic: {
    apiKey: '',
    model: 'claude-3-5-sonnet',
    baseUrl: 'https://api.anthropic.com/v1',
    maxOutputTokens: 16384,
  },
  ollama: {
    apiKey: 'ollama-no-key',
    model: 'llama3',
    baseUrl: 'http://localhost:11434/v1',
    maxOutputTokens: 16384,
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

const CURRENT_SETTINGS_VERSION = 2

interface VersionedCookieData<T> {
  version: number
  data: T
}

export const DEFAULT_SYSTEM_PROMPTS: SystemPromptTemplate[] = [
  {
    id: 'prompt-none',
    name: 'General Assistant',
    content: '',
  },
  {
    id: 'prompt-academic',
    name: 'Academic Style',
    content: 'Write in a highly academic, formal, and rigorous tone. Use precise terminology and passive voice where appropriate for scientific style.',
  },
  {
    id: 'prompt-concise',
    name: 'Concise Editor',
    content: 'Be extremely concise. Eliminate all unnecessary words, explanations, and redundant sentences. Focus on high information density.',
  },
  {
    id: 'prompt-creative',
    name: 'Creative Storyteller',
    content: 'Emphasize narrative flow, engaging vocabulary, sensory details, and vivid imagery. Adapt tone to be highly expressive.',
  }
]

const CURRENT_PROMPTS_VERSION = 1

interface VersionedPromptsData {
  version: number
  prompts: SystemPromptTemplate[]
  activePromptId: string
}

const saveSystemPromptsToCookie = (prompts: SystemPromptTemplate[], activePromptId: string) => {
  // 1. Save to localStorage as a fallback backup to bypass 4KB cookie limits or secure context issues
  try {
    localStorage.setItem('web_canvas_system_prompts_backup', JSON.stringify({
      version: CURRENT_PROMPTS_VERSION,
      prompts,
      activePromptId
    }))
  } catch (e) {
    console.error('Failed to save prompts backup to localStorage', e)
  }

  // 2. Only save custom prompts or modified default prompts to the cookie to save space (cookie limit is 4KB)
  const promptsToSave = prompts.filter(p => {
    const defaultPrompt = DEFAULT_SYSTEM_PROMPTS.find(d => d.id === p.id)
    if (!defaultPrompt) return true // User-created prompt
    return p.name !== defaultPrompt.name || p.content !== defaultPrompt.content // Modified default prompt
  })

  const envelope: VersionedPromptsData = {
    version: CURRENT_PROMPTS_VERSION,
    prompts: promptsToSave,
    activePromptId,
  }
  setCookie('__Secure-web_canvas_system_prompts', JSON.stringify(envelope))
}

const loadSavedSystemPromptsData = (): { prompts: SystemPromptTemplate[]; activePromptId: string } => {
  const saved = getCookie('__Secure-web_canvas_system_prompts')
  let parsed: any = null

  // Try loading from cookie first
  if (saved) {
    try {
      parsed = JSON.parse(saved)
      if (parsed && typeof parsed === 'object' && parsed.version === CURRENT_PROMPTS_VERSION) {
        const savedPrompts = parsed.prompts || []
        const mergedPrompts = [...DEFAULT_SYSTEM_PROMPTS]
        savedPrompts.forEach((sp: SystemPromptTemplate) => {
          const defaultIndex = mergedPrompts.findIndex(d => d.id === sp.id)
          if (defaultIndex !== -1) {
            mergedPrompts[defaultIndex] = sp
          } else {
            mergedPrompts.push(sp)
          }
        })
        return {
          prompts: mergedPrompts,
          activePromptId: parsed.activePromptId || 'prompt-none'
        }
      }
    } catch (e) {
      console.error('Failed to parse saved system prompts from cookie, trying fallback', e)
    }
  }

  // If cookie was empty or failed, load from localStorage backup
  const backup = localStorage.getItem('web_canvas_system_prompts_backup')
  if (backup) {
    try {
      parsed = JSON.parse(backup)
      if (parsed && typeof parsed === 'object' && parsed.version === CURRENT_PROMPTS_VERSION) {
        return {
          prompts: parsed.prompts || DEFAULT_SYSTEM_PROMPTS,
          activePromptId: parsed.activePromptId || 'prompt-none'
        }
      }
    } catch (e) {
      console.error('Failed to parse system prompts backup from localStorage', e)
    }
  }

  return {
    prompts: DEFAULT_SYSTEM_PROMPTS,
    activePromptId: 'prompt-none'
  }
}

const saveConfigsToCookie = (configs: Record<LLMProvider, ProviderConfig>) => {
  const envelope: VersionedCookieData<Record<LLMProvider, ProviderConfig>> = {
    version: CURRENT_SETTINGS_VERSION,
    data: configs,
  }
  const jsonStr = JSON.stringify(envelope)
  
  // 1. Save to localStorage as a fallback backup
  try {
    localStorage.setItem('web_canvas_providers_backup', jsonStr)
  } catch (e) {
    console.error('Failed to save configs backup to localStorage', e)
  }

  // 2. Save to cookie
  setCookie('__Secure-web_canvas_providers', jsonStr)
}

const migrateProvidersConfig = (savedString: string): Record<LLMProvider, ProviderConfig> => {
  try {
    const parsed = JSON.parse(savedString)
    
    // Case 1: Legacy unversioned structure (direct Record<LLMProvider, ProviderConfig>)
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
      console.log('Migrating legacy (v0) LLM configs to v2')
      const migratedData = { ...DEFAULT_CONFIGS }
      const rawData = parsed as any
      let legacyPromptText = ''
      for (const p of Object.keys(DEFAULT_CONFIGS) as LLMProvider[]) {
        if (rawData && rawData[p]) {
          migratedData[p] = {
            ...DEFAULT_CONFIGS[p],
            ...rawData[p],
          }
          if (rawData[p].systemPrompt && !legacyPromptText) {
            legacyPromptText = rawData[p].systemPrompt
          }
          // Clean up legacy prompt field
          delete (migratedData[p] as any).systemPrompt
        }
      }

      if (legacyPromptText && legacyPromptText.trim()) {
        const importedId = `prompt-imported-${Date.now()}`
        const importedPrompt: SystemPromptTemplate = {
          id: importedId,
          name: 'Imported Preset',
          content: legacyPromptText,
        }
        saveSystemPromptsToCookie([...DEFAULT_SYSTEM_PROMPTS, importedPrompt], importedId)
      }
      
      // Save versioned cookie immediately
      saveConfigsToCookie(migratedData)
      return migratedData
    }

    // Case 2: Versioned structure
    const versioned = parsed as VersionedCookieData<Record<LLMProvider, ProviderConfig>>
    let currentData = versioned.data
    let version = versioned.version

    if (version === 1) {
      console.log('Migrating version 1 LLM configs to v2')
      let legacyPromptText = ''
      for (const p of Object.keys(DEFAULT_CONFIGS) as LLMProvider[]) {
        if (currentData[p] && (currentData[p] as any).systemPrompt) {
          legacyPromptText = (currentData[p] as any).systemPrompt
          // Clean up legacy prompt field
          delete (currentData[p] as any).systemPrompt
        }
      }
      if (legacyPromptText && legacyPromptText.trim()) {
        const importedId = `prompt-imported-${Date.now()}`
        const importedPrompt: SystemPromptTemplate = {
          id: importedId,
          name: 'Imported Preset',
          content: legacyPromptText,
        }
        saveSystemPromptsToCookie([...DEFAULT_SYSTEM_PROMPTS, importedPrompt], importedId)
      }
      version = 2
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
  const backup = localStorage.getItem('web_canvas_providers_backup')
  if (backup) {
    return migrateProvidersConfig(backup)
  }
  return DEFAULT_CONFIGS
}

const loadSavedProvider = (): LLMProvider => {
  const saved = localStorage.getItem('web_canvas_active_provider')
  if (saved && ['openai', 'gemini', 'anthropic', 'ollama'].includes(saved)) {
    return saved as LLMProvider
  }
  const cookieSaved = getCookie('__Secure-web_canvas_active_provider')
  if (cookieSaved && ['openai', 'gemini', 'anthropic', 'ollama'].includes(cookieSaved)) {
    localStorage.setItem('web_canvas_active_provider', cookieSaved)
    return cookieSaved as LLMProvider
  }
  return 'gemini'
}

const loadSavedTheme = (): 'dark' | 'light' => {
  const saved = localStorage.getItem('web_canvas_theme')
  if (saved === 'dark' || saved === 'light') return saved
  const cookieSaved = getCookie('__Secure-web_canvas_theme')
  if (cookieSaved === 'dark' || cookieSaved === 'light') {
    localStorage.setItem('web_canvas_theme', cookieSaved)
    return cookieSaved
  }
  return 'dark'
}

const loadSavedSidebarOpen = (): boolean => {
  const saved = localStorage.getItem('web_canvas_sidebar_open')
  if (saved !== null) return saved !== 'false'
  const cookieSaved = getCookie('__Secure-web_canvas_sidebar_open')
  if (cookieSaved !== '') {
    localStorage.setItem('web_canvas_sidebar_open', cookieSaved)
    return cookieSaved !== 'false'
  }
  return true
}

const loadSavedDebugMode = (): boolean => {
  const saved = localStorage.getItem('web_canvas_debug_mode')
  if (saved !== null) return saved === 'true'
  const cookieSaved = getCookie('__Secure-web_canvas_debug_mode')
  if (cookieSaved !== '') {
    localStorage.setItem('web_canvas_debug_mode', cookieSaved)
    return cookieSaved === 'true'
  }
  return false
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
  const initialPromptsData = loadSavedSystemPromptsData()
  if (!localStorage.getItem('web_canvas_system_prompts') && !getCookie('__Secure-web_canvas_system_prompts')) {
    saveSystemPromptsToCookie(initialPromptsData.prompts, initialPromptsData.activePromptId)
  }
  const isEnvDebug = import.meta.env.VITE_DEBUG === 'true' || import.meta.env.MODE === 'debug'
  const initialDebugMode = isEnvDebug || loadSavedDebugMode() || (localStorage.getItem('web_canvas_debug_mode') === null && getCookie('__Secure-web_canvas_debug_mode') === '' && import.meta.env.DEV)

  return {
    // Theme state
    theme: loadSavedTheme(),
    setTheme: (theme) => {
      localStorage.setItem('web_canvas_theme', theme)
      setCookie('__Secure-web_canvas_theme', theme)
      set({ theme })
    },

    // Multi-document state
    documents: initialDocs,
    activeDocumentId: initialActiveId,
    isSidebarOpen: loadSavedSidebarOpen(),
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
        setCookie('__Secure-web_canvas_sidebar_open', String(isOpen))
        return { isSidebarOpen: isOpen }
      })
    },

    // LLM configurations
    activeProvider: loadSavedProvider(),
    providerConfigs: loadSavedConfigs(),
    availableGeminiModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash-8b'],
    setProvider: (provider) => {
      localStorage.setItem('web_canvas_active_provider', provider)
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
    debugMode: initialDebugMode,
    setDebugMode: (enabled) => {
      localStorage.setItem('web_canvas_debug_mode', String(enabled))
      setCookie('__Secure-web_canvas_debug_mode', String(enabled))
      set({ debugMode: enabled })
    },

    // System prompts state
    customSystemPrompts: initialPromptsData.prompts,
    activeSystemPromptId: initialPromptsData.activePromptId,
    setActiveSystemPromptId: (id) => {
      set((state) => {
        saveSystemPromptsToCookie(state.customSystemPrompts, id)
        return { activeSystemPromptId: id }
      })
    },
    addSystemPrompt: (name = 'New Preset', content = '') => {
      const newPrompt: SystemPromptTemplate = {
        id: `prompt-${Date.now()}`,
        name,
        content
      }
      let promptId = newPrompt.id
      set((state) => {
        const updated = [...state.customSystemPrompts, newPrompt]
        saveSystemPromptsToCookie(updated, state.activeSystemPromptId)
        return { customSystemPrompts: updated }
      })
      return promptId
    },
    updateSystemPrompt: (id, updates) => {
      set((state) => {
        const updated = state.customSystemPrompts.map((p) => {
          if (p.id === id) {
            return { ...p, ...updates }
          }
          return p
        })
        saveSystemPromptsToCookie(updated, state.activeSystemPromptId)
        return { customSystemPrompts: updated }
      })
    },
    deleteSystemPrompt: (id) => {
      set((state) => {
        const updated = state.customSystemPrompts.filter((p) => p.id !== id)
        let activeId = state.activeSystemPromptId
        if (state.activeSystemPromptId === id) {
          activeId = updated[0]?.id || 'prompt-none'
        }
        saveSystemPromptsToCookie(updated, activeId)
        return { 
          customSystemPrompts: updated,
          activeSystemPromptId: activeId
        }
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
