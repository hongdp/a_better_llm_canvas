import { create } from 'zustand'

export type LLMProvider = 'openai' | 'gemini' | 'anthropic' | 'ollama' | 'grok'

export const PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash-8b'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o1-preview', 'o1-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  anthropic: ['claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus', 'claude-3-sonnet'],
  ollama: ['llama3', 'mistral', 'gemma2', 'codegemma', 'phi3'],
  grok: ['grok-4.3', 'grok-build-0.1', 'grok-3', 'grok-2', 'grok-2-vision', 'grok-beta']
}

const localStorage = typeof window !== 'undefined' ? window.localStorage : {
  setItem: () => {},
  getItem: () => null,
  removeItem: () => {},
  key: () => null,
  get length() { return 0 }
}

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
  provider?: string
  model?: string
}

export interface DocumentVersion {
  id: string
  documentId: string
  timestamp: string
  title: string
  content: string
}

export interface CanvasDocument {
  id: string
  title: string
  content: string
  selectedReferenceIds?: string[]
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
  bookTitle: string
  setBookTitle: (title: string) => void
  
  setActiveDocumentId: (id: string) => void
  addDocument: (title?: string, content?: string) => string
  importAllDocuments: (docs: { title: string; content: string }[]) => void
  reorderDocuments: (newDocs: CanvasDocument[]) => void
  deleteDocument: (id: string) => void
  updateActiveDocument: (updates: Partial<CanvasDocument>) => void
  toggleReference: (id: string) => void
  clearReferences: () => void
  toggleSidebar: () => void

  // Version history state
  versions: DocumentVersion[]
  createVersionSnapshot: (title?: string) => void
  restoreVersion: (versionId: string) => void
  deleteVersionSnapshot: (versionId: string) => void

  // LLM configurations
  activeProvider: LLMProvider
  providerConfigs: Record<LLMProvider, ProviderConfig>
  setProvider: (provider: LLMProvider) => void
  updateProviderConfig: (provider: LLMProvider, config: Partial<ProviderConfig>) => void
  availableGeminiModels: string[]
  setAvailableGeminiModels: (models: string[]) => void
  availableGrokModels: string[]
  setAvailableGrokModels: (models: string[]) => void
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

  // Selection & editor integration for inline diff review
  selectedText: string
  setSelectedText: (text: string) => void
  activeEditor: any
  setActiveEditor: (editor: any) => void

  // Session stats & local storage tracking
  sessionInputTokens: number
  sessionOutputTokens: number
  sessionCacheHitTokens: number
  sessionCacheMissTokens: number
  addSessionTokens: (input: number, output: number, cacheHit?: number) => void
  resetSessionTokens: () => void

  // Storage & Sync state
  isStoreInitialized: boolean
  setIsStoreInitialized: (initialized: boolean) => void

  // Multi-book state
  activeBookId: string
  availableBooks: { id: string; title: string; updatedAt: string }[]
  isLoadingBooks: boolean
  fetchAvailableBooks: () => Promise<void>
  createNewBook: (title?: string) => Promise<void>
  switchBook: (id: string) => Promise<void>
  deleteBook: (id: string) => Promise<void>

  // Auth state
  user: { username: string } | null
  csrfToken: string | null
  setUser: (user: { username: string } | null) => void
  setCsrfToken: (token: string | null) => void
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  checkSession: () => Promise<void>
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
    apiKey: import.meta.env.VITE_OPENAI_API_KEY || '',
    model: import.meta.env.VITE_OPENAI_MODEL || 'gpt-4o',
    baseUrl: import.meta.env.VITE_OPENAI_BASE_URL || 'https://api.openai.com/v1',
    maxOutputTokens: 16384,
  },
  gemini: {
    apiKey: import.meta.env.VITE_GEMINI_API_KEY || '',
    model: import.meta.env.VITE_GEMINI_MODEL || 'gemini-1.5-pro',
    baseUrl: import.meta.env.VITE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    geminiSafetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
    maxOutputTokens: 16384,
  },
  anthropic: {
    apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY || '',
    model: import.meta.env.VITE_ANTHROPIC_MODEL || 'claude-3-5-sonnet',
    baseUrl: import.meta.env.VITE_ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
    maxOutputTokens: 16384,
  },
  ollama: {
    apiKey: import.meta.env.VITE_OLLAMA_API_KEY || 'ollama-no-key',
    model: import.meta.env.VITE_OLLAMA_MODEL || 'llama3',
    baseUrl: import.meta.env.VITE_OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    maxOutputTokens: 16384,
  },
  grok: {
    apiKey: import.meta.env.VITE_GROK_API_KEY || '',
    model: import.meta.env.VITE_GROK_MODEL || 'grok-3',
    baseUrl: import.meta.env.VITE_GROK_BASE_URL || 'https://api.x.ai/v1',
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
  let parsed: any = null

  // 1. Try loading from localStorage backup first (prioritized)
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

  // 2. Fallback to cookie
  const saved = getCookie('__Secure-web_canvas_system_prompts')
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
      console.error('Failed to parse saved system prompts from cookie', e)
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
  const backup = localStorage.getItem('web_canvas_providers_backup')
  if (backup) {
    return migrateProvidersConfig(backup)
  }
  const saved = getCookie('__Secure-web_canvas_providers')
  if (saved) {
    return migrateProvidersConfig(saved)
  }
  return DEFAULT_CONFIGS
}

const loadSavedProvider = (): LLMProvider => {
  const saved = localStorage.getItem('web_canvas_active_provider')
  if (saved && ['openai', 'gemini', 'anthropic', 'ollama', 'grok'].includes(saved)) {
    return saved as LLMProvider
  }
  const cookieSaved = getCookie('__Secure-web_canvas_active_provider')
  if (cookieSaved && ['openai', 'gemini', 'anthropic', 'ollama', 'grok'].includes(cookieSaved)) {
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

const loadSavedVersions = (): DocumentVersion[] => {
  const saved = localStorage.getItem('web_canvas_versions')
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch (e) {
      console.error('Failed to parse saved versions', e)
    }
  }
  return []
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
    selectedReferenceIds: initialDocs.find(d => d.id === initialActiveId)?.selectedReferenceIds || [],
    bookTitle: localStorage.getItem('web_canvas_book_title') || 'Untitled Book',
    setBookTitle: (title) => {
      localStorage.setItem('web_canvas_book_title', title)
      set({ bookTitle: title })
    },

    setActiveDocumentId: (id) => {
      localStorage.setItem('web_canvas_active_document_id', id)
      set((state) => {
        const targetDoc = state.documents.find((d) => d.id === id)
        return { 
          activeDocumentId: id,
          selectedReferenceIds: (targetDoc?.selectedReferenceIds || []).filter(refId => refId !== id)
        }
      })
    },

    addDocument: (title = 'New Chapter', content = '<p>Start writing...</p>') => {
      const newDoc: CanvasDocument = {
        id: `doc-${Date.now()}`,
        title,
        content,
        selectedReferenceIds: [],
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
          activeDocumentId: newDoc.id,
          selectedReferenceIds: []
        }
      })
      return docId
    },

    importAllDocuments: (newDocs) => {
      if (newDocs.length === 0) return

      const formattedDocs: CanvasDocument[] = newDocs.map((doc, idx) => ({
        id: `doc-${Date.now()}-${idx}`,
        title: doc.title || `Chapter ${idx + 1}`,
        content: doc.content || '<p></p>',
        selectedReferenceIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }))

      set(() => {
        localStorage.setItem('web_canvas_documents', JSON.stringify(formattedDocs))
        localStorage.setItem('web_canvas_active_document_id', formattedDocs[0].id)
        return {
          documents: formattedDocs,
          activeDocumentId: formattedDocs[0].id,
          selectedReferenceIds: []
        }
      })
    },

    reorderDocuments: (newDocs) => {
      set(() => {
        localStorage.setItem('web_canvas_documents', JSON.stringify(newDocs))
        return { documents: newDocs }
      })
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
            selectedReferenceIds: [],
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

        const updatedDocs = state.documents.map((d) => {
          if (d.id === state.activeDocumentId) {
            return {
              ...d,
              selectedReferenceIds: refs,
              updatedAt: new Date().toISOString(),
            }
          }
          return d
        })
        localStorage.setItem('web_canvas_documents', JSON.stringify(updatedDocs))
        return { 
          selectedReferenceIds: refs,
          documents: updatedDocs
        }
      })
    },

    clearReferences: () => {
      set((state) => {
        const updatedDocs = state.documents.map((d) => {
          if (d.id === state.activeDocumentId) {
            return {
              ...d,
              selectedReferenceIds: [],
              updatedAt: new Date().toISOString(),
            }
          }
          return d
        })
        localStorage.setItem('web_canvas_documents', JSON.stringify(updatedDocs))
        return {
          selectedReferenceIds: [],
          documents: updatedDocs
        }
      })
    },

    // Version history state
    versions: loadSavedVersions(),

    createVersionSnapshot: (title = 'Manual Snapshot') => {
      set((state) => {
        const activeDoc = state.documents.find(d => d.id === state.activeDocumentId)
        if (!activeDoc) return {}

        const newVersion: DocumentVersion = {
          id: `ver-${Date.now()}`,
          documentId: state.activeDocumentId,
          timestamp: new Date().toISOString(),
          title,
          content: activeDoc.content,
        }

        let updatedVersions = [newVersion, ...state.versions]
        if (updatedVersions.length > 50) {
          updatedVersions = updatedVersions.slice(0, 50)
        }

        localStorage.setItem('web_canvas_versions', JSON.stringify(updatedVersions))
        return { versions: updatedVersions }
      })
    },

    restoreVersion: (versionId) => {
      set((state) => {
        const version = state.versions.find(v => v.id === versionId)
        if (!version) return {}

        // Create an undo snapshot first
        const activeDoc = state.documents.find(d => d.id === state.activeDocumentId)
        let updatedVersions = state.versions
        if (activeDoc) {
          const preRestoreVersion: DocumentVersion = {
            id: `ver-${Date.now()}`,
            documentId: state.activeDocumentId,
            timestamp: new Date().toISOString(),
            title: `Auto-save before restoring "${version.title}"`,
            content: activeDoc.content,
          }
          updatedVersions = [preRestoreVersion, ...state.versions]
          if (updatedVersions.length > 50) {
            updatedVersions = updatedVersions.slice(0, 50)
          }
          localStorage.setItem('web_canvas_versions', JSON.stringify(updatedVersions))
        }

        const updatedDocs = state.documents.map((d) => {
          if (d.id === state.activeDocumentId) {
            return {
              ...d,
              content: version.content,
              updatedAt: new Date().toISOString(),
            }
          }
          return d
        })
        localStorage.setItem('web_canvas_documents', JSON.stringify(updatedDocs))

        return {
          documents: updatedDocs,
          versions: updatedVersions
        }
      })
    },

    deleteVersionSnapshot: (versionId) => {
      set((state) => {
        const filteredVersions = state.versions.filter(v => v.id !== versionId)
        localStorage.setItem('web_canvas_versions', JSON.stringify(filteredVersions))
        return { versions: filteredVersions }
      })
    },

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
    availableGrokModels: ['grok-4.3', 'grok-build-0.1', 'grok-3', 'grok-2', 'grok-2-vision', 'grok-beta'],
    setProvider: (provider) => {
      localStorage.setItem('web_canvas_active_provider', provider)
      setCookie('__Secure-web_canvas_active_provider', provider)
      set({ activeProvider: provider })
    },
    setAvailableGeminiModels: (models) => {
      set({ availableGeminiModels: models })
    },
    setAvailableGrokModels: (models) => {
      set({ availableGrokModels: models })
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

    // Selection & editor state implementation
    selectedText: '',
    setSelectedText: (text) => set({ selectedText: text }),
    activeEditor: null,
    setActiveEditor: (editor) => set({ activeEditor: editor }),

    // Session stats & local storage implementation
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    sessionCacheHitTokens: 0,
    sessionCacheMissTokens: 0,
    addSessionTokens: (input, output, cacheHit = 0) => set((state) => {
      const hit = cacheHit
      const miss = input - hit
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

    // Multi-book implementation
    activeBookId: localStorage.getItem('web_canvas_active_book_id') || 'default',
    availableBooks: [],
    isLoadingBooks: false,
    fetchAvailableBooks: async () => {
      const state = useAppStore.getState()
      if (!state.user) return

      set({ isLoadingBooks: true })
      try {
        const res = await fetch('/api/books')
        if (res.ok) {
          const books = await res.json()
          set({ availableBooks: books })
        }
      } catch (e) {
        console.error('Failed to fetch available books from server', e)
      } finally {
        set({ isLoadingBooks: false })
      }
    },
    createNewBook: async (title = 'New Book') => {
      const state = useAppStore.getState()
      const newBookId = `book-${Date.now()}`
      
      if (saveTimeout) {
        clearTimeout(saveTimeout)
        saveTimeout = null
      }

      const defaultDocs = [
        {
          id: 'doc-1',
          title: 'Chapter 1: Welcome',
          content: `<h1>Getting Started</h1><p>Start writing your new book here...</p>`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]

      const updates: Partial<AppState> = {
        bookTitle: title,
        documents: defaultDocs,
        versions: [],
        activeDocumentId: 'doc-1',
        messages: [
          {
            id: 'welcome',
            role: 'assistant',
            content: `Welcome to your new book "${title}"! How can I help you write today?`,
            timestamp: new Date().toISOString(),
          }
        ],
        activeBookId: newBookId
      }

      const wasInitialized = isInitialized
      isInitialized = false

      localStorage.setItem('web_canvas_active_book_id', newBookId)
      localStorage.setItem('web_canvas_book_title', title)
      localStorage.setItem('web_canvas_documents', JSON.stringify(defaultDocs))
      localStorage.setItem('web_canvas_versions', JSON.stringify([]))
      localStorage.setItem('web_canvas_active_document_id', 'doc-1')

      set(updates)

      isInitialized = wasInitialized

      if (state.user) {
        try {
          await fetch(`/api/storage?bookId=${newBookId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': state.csrfToken || ''
            },
            body: JSON.stringify({
              documents: defaultDocs,
              versions: [],
              bookTitle: title,
              activeDocumentId: 'doc-1',
              activeProvider: state.activeProvider,
              providerConfigs: state.providerConfigs,
              customSystemPrompts: state.customSystemPrompts,
              activeSystemPromptId: state.activeSystemPromptId,
              theme: state.theme,
              messages: updates.messages,
              debugMode: state.debugMode
            })
          })
          
          await useAppStore.getState().fetchAvailableBooks()
        } catch (e) {
          console.error('Failed to save new book to server', e)
        }
      }
    },
    switchBook: async (id) => {
      const state = useAppStore.getState()
      if (!state.user) return

      if (saveTimeout) {
        clearTimeout(saveTimeout)
        saveTimeout = null
      }

      try {
        const res = await fetch(`/api/storage?bookId=${id}`)
        if (res.ok) {
          const server = await res.json()
          if (server && typeof server === 'object' && Object.keys(server).length > 0) {
            const wasInitialized = isInitialized
            isInitialized = false

            const updates: Partial<AppState> = {
              activeBookId: id
            }
            localStorage.setItem('web_canvas_active_book_id', id)

            if (server.documents) {
              updates.documents = server.documents
              localStorage.setItem('web_canvas_documents', JSON.stringify(server.documents))
            }
            if (server.versions) {
              updates.versions = server.versions
              localStorage.setItem('web_canvas_versions', JSON.stringify(server.versions))
            }
            if (server.bookTitle) {
              updates.bookTitle = server.bookTitle
              localStorage.setItem('web_canvas_book_title', server.bookTitle)
            }
            if (server.activeDocumentId) {
              updates.activeDocumentId = server.activeDocumentId
              localStorage.setItem('web_canvas_active_document_id', server.activeDocumentId)
            }
            if (server.activeProvider) {
              updates.activeProvider = server.activeProvider
              localStorage.setItem('web_canvas_active_provider', server.activeProvider)
            }
            if (server.providerConfigs) {
              updates.providerConfigs = server.providerConfigs
              saveConfigsToCookie(server.providerConfigs)
            }
            if (server.customSystemPrompts) {
              updates.customSystemPrompts = server.customSystemPrompts
              saveSystemPromptsToCookie(server.customSystemPrompts, server.activeSystemPromptId || 'prompt-none')
            }
            if (server.activeSystemPromptId) {
              updates.activeSystemPromptId = server.activeSystemPromptId
            }
            if (server.theme) {
              updates.theme = server.theme
              localStorage.setItem('web_canvas_theme', server.theme)
            }
            if (server.messages) updates.messages = server.messages
            if (server.debugMode !== undefined) {
              updates.debugMode = server.debugMode
              localStorage.setItem('web_canvas_debug_mode', String(server.debugMode))
            }

            set(updates)
            isInitialized = wasInitialized
          }
        } else {
          if (res.status === 401) {
            useAppStore.setState({ user: null })
            alert('You have been logged out because another session has started on the server.')
            window.location.reload()
            return
          }
        }
      } catch (e) {
        console.error('Failed to switch book', e)
      }
    },
    deleteBook: async (id) => {
      const state = useAppStore.getState()
      if (!state.user) return
      if (id === state.activeBookId) {
        alert('Cannot delete the currently active book. Please switch to another book first.')
        return
      }

      try {
        const res = await fetch('/api/books/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': state.csrfToken || ''
          },
          body: JSON.stringify({ bookId: id })
        })
        if (res.ok) {
          await useAppStore.getState().fetchAvailableBooks()
        }
      } catch (e) {
        console.error('Failed to delete book on server', e)
      }
    },

    // Storage & Sync implementation
    isStoreInitialized: false,
    setIsStoreInitialized: (initialized) => set({ isStoreInitialized: initialized }),

    // Auth implementation
    user: null,
    csrfToken: null,
    setUser: (user) => set({ user }),
    setCsrfToken: (token) => set({ csrfToken: token }),
    login: async (username, password) => {
      const state = useAppStore.getState()
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': state.csrfToken || ''
        },
        body: JSON.stringify({ username, password })
      })
      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || 'Login failed.')
      }
      const data = await res.json()
      set({ user: { username: data.username }, csrfToken: data.csrfToken || state.csrfToken })
      
      // Perform sync verification for this logged in user
      await initializeStoreFromServer()
      // Fetch available books
      await useAppStore.getState().fetchAvailableBooks()
    },
    register: async (username, password) => {
      const state = useAppStore.getState()
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': state.csrfToken || ''
        },
        body: JSON.stringify({ username, password })
      })
      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || 'Registration failed.')
      }
    },
    logout: async () => {
      const state = useAppStore.getState()
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            'X-CSRF-Token': state.csrfToken || ''
          }
        })
      } catch (e) {
        console.error('Logout request failed', e)
      }
      set({ user: null })
      // Clear localStorage cache to be completely secure and avoid PII leaks
      localStorage.removeItem('web_canvas_documents')
      localStorage.removeItem('web_canvas_versions')
      localStorage.removeItem('web_canvas_book_title')
      localStorage.removeItem('web_canvas_active_document_id')
      localStorage.removeItem('web_canvas_active_book_id')
      set({ activeBookId: 'default', availableBooks: [] })
    },
    checkSession: async () => {
      try {
        const res = await fetch('/api/auth/session')
        if (res.ok) {
          const data = await res.json()
          set({ csrfToken: data.csrfToken })
          if (data.loggedIn) {
            set({ user: { username: data.username } })
          } else {
            set({ user: null })
          }
        }
      } catch (e) {
        console.error('Failed to check session', e)
      }
    }
  }
})

let isInitialized = false

export const initializeStoreFromServer = async () => {
  // 1. Fetch current session status first
  let loggedInUser: string | null = null
  let csrfToken: string | null = null
  try {
    const sessionRes = await fetch('/api/auth/session')
    if (sessionRes.ok) {
      const sessionData = await sessionRes.json()
      csrfToken = sessionData.csrfToken || null
      useAppStore.setState({ csrfToken })
      if (sessionData.loggedIn) {
        loggedInUser = sessionData.username
        useAppStore.setState({ user: { username: sessionData.username as string } })
      } else {
        useAppStore.setState({ user: null })
      }
    }
  } catch (e) {
    console.error('Session verification failed', e)
  }

  // 2. If not logged in, stop and wait for auth (AuthForm will be shown)
  if (!loggedInUser) {
    useAppStore.setState({ isStoreInitialized: true })
    isInitialized = true
    return
  }

  // 3. Continue initialization for logged-in user: fetch book state from server
  const activeBookId = localStorage.getItem('web_canvas_active_book_id') || 'default'

  try {
    const res = await fetch(`/api/storage?bookId=${activeBookId}`)
    if (res.ok) {
      const serverData = await res.json()
      if (serverData && typeof serverData === 'object' && Object.keys(serverData).length > 0) {
        // Load server-side updates and boot
        const updates: Partial<AppState> = {}
        if (serverData.documents) {
          updates.documents = serverData.documents
          localStorage.setItem('web_canvas_documents', JSON.stringify(serverData.documents))
        }
        if (serverData.versions) {
          updates.versions = serverData.versions
          localStorage.setItem('web_canvas_versions', JSON.stringify(serverData.versions))
        }
        if (serverData.bookTitle) {
          updates.bookTitle = serverData.bookTitle
          localStorage.setItem('web_canvas_book_title', serverData.bookTitle)
        }
        if (serverData.activeDocumentId) {
          updates.activeDocumentId = serverData.activeDocumentId
          localStorage.setItem('web_canvas_active_document_id', serverData.activeDocumentId)
        }
        if (serverData.activeProvider) {
          updates.activeProvider = serverData.activeProvider
          localStorage.setItem('web_canvas_active_provider', serverData.activeProvider)
        }
        if (serverData.providerConfigs) {
          updates.providerConfigs = serverData.providerConfigs
          saveConfigsToCookie(serverData.providerConfigs)
        }
        if (serverData.customSystemPrompts) {
          updates.customSystemPrompts = serverData.customSystemPrompts
          saveSystemPromptsToCookie(serverData.customSystemPrompts, serverData.activeSystemPromptId || 'prompt-none')
        }
        if (serverData.activeSystemPromptId) {
          updates.activeSystemPromptId = serverData.activeSystemPromptId
        }
        if (serverData.theme) {
          updates.theme = serverData.theme
          localStorage.setItem('web_canvas_theme', serverData.theme)
        }
        if (serverData.messages) updates.messages = serverData.messages
        if (serverData.debugMode !== undefined) {
          updates.debugMode = serverData.debugMode
          localStorage.setItem('web_canvas_debug_mode', String(serverData.debugMode))
        }

        useAppStore.setState(updates)
      } else {
        // Server is empty, initialize server with initial client/default state
        const state = useAppStore.getState()
        await fetch(`/api/storage?bookId=${activeBookId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': state.csrfToken || ''
          },
          body: JSON.stringify({
            documents: state.documents,
            versions: state.versions,
            bookTitle: state.bookTitle,
            activeDocumentId: state.activeDocumentId,
            activeProvider: state.activeProvider,
            providerConfigs: state.providerConfigs,
            customSystemPrompts: state.customSystemPrompts,
            activeSystemPromptId: state.activeSystemPromptId,
            theme: state.theme,
            messages: state.messages,
            debugMode: state.debugMode
          })
        })
      }
    }
  } catch (e) {
    console.error('Failed to load server data during initialization', e)
  } finally {
    useAppStore.setState({ isStoreInitialized: true })
    isInitialized = true
    // Fetch available books list after store is initialized
    await useAppStore.getState().fetchAvailableBooks()
  }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null

useAppStore.subscribe((state) => {
  if (!isInitialized) return
  if (!state.user) return // Don't auto-save if user is not logged in

  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`/api/storage?bookId=${state.activeBookId || 'default'}`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-CSRF-Token': state.csrfToken || ''
        },
        body: JSON.stringify({
          documents: state.documents,
          versions: state.versions,
          bookTitle: state.bookTitle,
          activeDocumentId: state.activeDocumentId,
          activeProvider: state.activeProvider,
          providerConfigs: state.providerConfigs,
          customSystemPrompts: state.customSystemPrompts,
          activeSystemPromptId: state.activeSystemPromptId,
          theme: state.theme,
          messages: state.messages,
          debugMode: state.debugMode
        })
      })
      if (res.status === 401) {
        useAppStore.setState({ user: null })
        alert('You have been logged out because another session has started on the server.')
        window.location.reload()
      }
    } catch {
      // Server storage API not running
    }
  }, 3000) // 3-second debounce to accumulate edits and reduce server communication
})

