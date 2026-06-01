import { create } from 'zustand'

// Re-export shared types for backward compatibility
export type { LLMProvider, ImageGenProvider, ImageGenConfig, GeminiSafetySetting, ProviderConfig, SystemPromptTemplate } from '../types/llm'
export { PROVIDER_MODELS } from '../types/llm'
export type { ChatMessage } from '../types/chat'
export type { DocumentVersion, CanvasDocument } from '../types/document'

import type { LLMProvider, ImageGenConfig, ProviderConfig, SystemPromptTemplate } from '../types/llm'
import type { ChatMessage } from '../types/chat'
import type { DocumentVersion, CanvasDocument } from '../types/document'


import { localStorage, db, safeIndexedDBSet, saveDocumentsToIndexedDB, flushPendingDocumentSave } from './persistence'

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    const state = useAppStore.getState()
    flushPendingDocumentSave(state.documents)
  })
}



interface AppState {
  // Theme & Language state
  theme: 'dark' | 'light'
  setTheme: (theme: 'dark' | 'light') => void
  language: 'en' | 'zh'
  setLanguage: (lang: 'en' | 'zh') => void

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
  updateDocument: (id: string, updates: Partial<CanvasDocument>) => void
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

  // Image analysis prompt
  imageAnalysisPrompt: string
  setImageAnalysisPrompt: (prompt: string) => void

  // Image generation config
  imageGenConfig: ImageGenConfig
  updateImageGenConfig: (updates: Partial<ImageGenConfig>) => void

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
  serverSaveStatus: 'saved' | 'saving' | 'failed' | 'local-only'
  setServerSaveStatus: (status: 'saved' | 'saving' | 'failed' | 'local-only') => void
  syncToServer: () => Promise<void>

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
  lastSyncedAt: string | null
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

const saveSystemPromptsToCookie = (prompts: SystemPromptTemplate[], activePromptId: string) => {
  try {
    localStorage.setItem('web_canvas_system_prompts_backup', JSON.stringify({
      version: CURRENT_PROMPTS_VERSION,
      prompts,
      activePromptId
    }))
  } catch (e) {
    console.error('Failed to save prompts backup to localStorage', e)
  }

  // Clear the old cookie if it exists to clean up bloated request headers
  if (getCookie('__Secure-web_canvas_system_prompts')) {
    setCookie('__Secure-web_canvas_system_prompts', '', -1)
  }
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
      // Clean up the cookie since we've migrated
      setCookie('__Secure-web_canvas_system_prompts', '', -1)
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
        const activePromptId = parsed.activePromptId || 'prompt-none'
        // Save to localStorage immediately so it's backed up
        try {
          localStorage.setItem('web_canvas_system_prompts_backup', JSON.stringify({
            version: CURRENT_PROMPTS_VERSION,
            prompts: mergedPrompts,
            activePromptId
          }))
        } catch (e) {
          console.error('Failed to save prompts backup to localStorage', e)
        }
        return {
          prompts: mergedPrompts,
          activePromptId
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
  
  // 1. Save to localStorage
  try {
    localStorage.setItem('web_canvas_providers_backup', jsonStr)
  } catch (e) {
    console.error('Failed to save configs backup to localStorage', e)
  }

  // 2. Clear old cookie
  if (getCookie('__Secure-web_canvas_providers')) {
    setCookie('__Secure-web_canvas_providers', '', -1)
  }
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
      
      // Save versioned localStorage immediately
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
    const configs = migrateProvidersConfig(saved)
    setCookie('__Secure-web_canvas_providers', '', -1)
    // Save to localStorage immediately so it's backed up
    try {
      localStorage.setItem('web_canvas_providers_backup', JSON.stringify({
        version: CURRENT_SETTINGS_VERSION,
        data: configs
      }))
    } catch (e) {
      console.error('Failed to save migrated configs backup to localStorage', e)
    }
    return configs
  }
  return DEFAULT_CONFIGS
}

const mergeProviderConfigs = (
  current: Record<LLMProvider, ProviderConfig>,
  incoming: Record<LLMProvider, ProviderConfig>
): Record<LLMProvider, ProviderConfig> => {
  const merged = { ...current }
  for (const provider of Object.keys(current) as LLMProvider[]) {
    const currentConfig = current[provider]
    const incomingConfig = incoming[provider]
    
    const apiKey = (incomingConfig && incomingConfig.apiKey && incomingConfig.apiKey.trim() !== '') 
      ? incomingConfig.apiKey 
      : ((currentConfig && currentConfig.apiKey) || '')
      
    merged[provider] = {
      ...DEFAULT_CONFIGS[provider],
      ...currentConfig,
      ...incomingConfig,
      apiKey
    }
  }
  return merged
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

const loadSavedLanguage = (): 'en' | 'zh' => {
  const saved = localStorage.getItem('web_canvas_language')
  if (saved === 'en' || saved === 'zh') return saved
  const cookieSaved = getCookie('__Secure-web_canvas_language')
  if (cookieSaved === 'en' || cookieSaved === 'zh') {
    localStorage.setItem('web_canvas_language', cookieSaved)
    return cookieSaved
  }
  // Auto-detect browser language if possible
  if (typeof navigator !== 'undefined' && navigator.language.startsWith('zh')) {
    return 'zh'
  }
  return 'en'
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

export const DEFAULT_IMAGE_ANALYSIS_PROMPT = `你是一位专业的图片描述专家，擅长描写人物细节。请仔细观察提供的图片，重点关注图片中的人物，写一段详细的中文描述。

要求（按优先级）：
1. **人物（最重要）**：若图片中有人，重点描写：
   - 外貌特征：年龄感、发型发色、五官、肤色、体型等
   - 身体部位：尽量描写可见的身体部位，如：手（手势、指甲）、手臂（是否裸露、肌肉感）、腿（长度感、裤腿/裙摆覆盖情况）、脚（鞋子款式）、肩部、颈部、腰部等，结合姿势描写
   - 穿着打扮：服装款式、颜色、风格（如休闲、正式、时尚等）、配饰
   - 姿势与位置：站姿、坐姿、动作、在画面中的位置（左/右/中/前/后）
   - 表情与神态：喜悦、严肃、自然等
   - 若有多人，分别描写每个人的特征及相互关系/位置关系
2. **场景与环境**：简要描述背景、地点、氛围等
3. 使用中文描述，长度在 100-250 字之间
4. 输出严格的 JSON 格式，不要有任何其他文字

JSON格式：
{
  "descriptions": [
    {"index": {{index}}, "description": "图片描述内容..."}
  ]
}`

const loadSavedImageAnalysisPrompt = (): string => {
  const saved = localStorage.getItem('web_canvas_image_analysis_prompt')
  return saved !== null ? saved : DEFAULT_IMAGE_ANALYSIS_PROMPT
}

const DEFAULT_IMAGE_GEN_CONFIG: ImageGenConfig = {
  provider: 'openai',
  apiKey: import.meta.env.VITE_OPENAI_API_KEY || '',
  model: 'dall-e-3',
  baseUrl: '',
  styleSystemPrompt: '',       // empty = use DEFAULT_IMAGE_STYLE_SYSTEM_PROMPT from imageGen.ts
  llmEnhancementEnabled: true, // enhance prompts with LLM by default
}

const loadSavedImageGenConfig = (): ImageGenConfig => {
  const saved = localStorage.getItem('web_canvas_image_gen_config')
  if (saved) {
    try {
      return { ...DEFAULT_IMAGE_GEN_CONFIG, ...JSON.parse(saved) }
    } catch (e) {
      console.error('Failed to parse saved image gen config', e)
    }
  }
  return DEFAULT_IMAGE_GEN_CONFIG
}



const loadSavedActiveDocId = (docs: CanvasDocument[]): string => {
  const saved = localStorage.getItem('web_canvas_active_document_id')
  if (saved && docs.some((d) => d.id === saved)) {
    return saved
  }
  return docs[0]?.id || ''
}



export const useAppStore = create<AppState>((set) => {
  const initialDocs = MOCK_DOCUMENTS
  const initialActiveId = loadSavedActiveDocId(initialDocs)
  const initialPromptsData = loadSavedSystemPromptsData()
  if (!localStorage.getItem('web_canvas_system_prompts_backup') && !getCookie('__Secure-web_canvas_system_prompts')) {
    saveSystemPromptsToCookie(initialPromptsData.prompts, initialPromptsData.activePromptId)
  }
  const isEnvDebug = import.meta.env.VITE_DEBUG === 'true' || import.meta.env.MODE === 'debug'
  const initialDebugMode = isEnvDebug || loadSavedDebugMode() || (localStorage.getItem('web_canvas_debug_mode') === null && getCookie('__Secure-web_canvas_debug_mode') === '' && import.meta.env.DEV)

  return {
    // Theme & Language state
    theme: loadSavedTheme(),
    setTheme: (theme) => {
      localStorage.setItem('web_canvas_theme', theme)
      setCookie('__Secure-web_canvas_theme', theme)
      set({ theme })
    },
    language: loadSavedLanguage(),
    setLanguage: (language) => {
      localStorage.setItem('web_canvas_language', language)
      setCookie('__Secure-web_canvas_language', language)
      set({ language })
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
        saveDocumentsToIndexedDB(updatedDocs, true)
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
        saveDocumentsToIndexedDB(formattedDocs, true)
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
        saveDocumentsToIndexedDB(newDocs, true)
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

        saveDocumentsToIndexedDB(filteredDocs, true)
        localStorage.setItem('web_canvas_active_document_id', newActiveId)

        return {
          documents: filteredDocs,
          activeDocumentId: newActiveId,
          // Remove from selected reference list if present
          selectedReferenceIds: state.selectedReferenceIds.filter((refId) => refId !== id)
        }
      })
    },

    updateDocument: (id, updates) => {
      set((state) => {
        const updatedDocs = state.documents.map((d) => {
          if (d.id === id) {
            return {
              ...d,
              ...updates,
              updatedAt: new Date().toISOString(),
            }
          }
          return d
        })
        saveDocumentsToIndexedDB(updatedDocs, false)
        return { documents: updatedDocs }
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
        saveDocumentsToIndexedDB(updatedDocs, false)
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
        saveDocumentsToIndexedDB(updatedDocs, true)
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
        saveDocumentsToIndexedDB(updatedDocs, true)
        return {
          selectedReferenceIds: [],
          documents: updatedDocs
        }
      })
    },

    // Version history state
    versions: [],

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

        safeIndexedDBSet('web_canvas_versions', updatedVersions)
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
          safeIndexedDBSet('web_canvas_versions', updatedVersions)
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
        saveDocumentsToIndexedDB(updatedDocs, true)

        return {
          documents: updatedDocs,
          versions: updatedVersions
        }
      })
    },

    deleteVersionSnapshot: (versionId) => {
      set((state) => {
        const filteredVersions = state.versions.filter(v => v.id !== versionId)
        safeIndexedDBSet('web_canvas_versions', filteredVersions)
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

    imageAnalysisPrompt: loadSavedImageAnalysisPrompt(),
    setImageAnalysisPrompt: (prompt) => {
      localStorage.setItem('web_canvas_image_analysis_prompt', prompt)
      set({ imageAnalysisPrompt: prompt })
    },

    // Image generation config
    imageGenConfig: loadSavedImageGenConfig(),
    updateImageGenConfig: (updates) => {
      set((state) => {
        const newConfig = { ...state.imageGenConfig, ...updates }
        localStorage.setItem('web_canvas_image_gen_config', JSON.stringify(newConfig))
        return { imageGenConfig: newConfig }
      })
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
      saveDocumentsToIndexedDB(defaultDocs, true)
      safeIndexedDBSet('web_canvas_versions', [])
      localStorage.setItem('web_canvas_active_document_id', 'doc-1')

      set(updates)

      isInitialized = wasInitialized

      if (state.user) {
        set({ serverSaveStatus: 'saving' })
        try {
          const res = await fetch(`/api/storage?bookId=${newBookId}`, {
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
          
          if (res.ok) {
            set({ serverSaveStatus: 'saved', lastSyncedAt: new Date().toISOString() })
          } else {
            set({ serverSaveStatus: 'failed' })
          }
          await useAppStore.getState().fetchAvailableBooks()
        } catch (e) {
          console.error('Failed to save new book to server', e)
          set({ serverSaveStatus: 'failed' })
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

      set({ serverSaveStatus: 'saving' })
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
              saveDocumentsToIndexedDB(server.documents, true)
            }
            if (server.versions) {
              updates.versions = server.versions
              safeIndexedDBSet('web_canvas_versions', server.versions)
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
              const currentConfigs = state.providerConfigs || loadSavedConfigs()
              const mergedConfigs = mergeProviderConfigs(currentConfigs, server.providerConfigs)
              updates.providerConfigs = mergedConfigs
              saveConfigsToCookie(mergedConfigs)
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
          set({ serverSaveStatus: 'saved', lastSyncedAt: new Date().toISOString() })
        } else {
          set({ serverSaveStatus: 'failed' })
          if (res.status === 401) {
            useAppStore.setState({ user: null, serverSaveStatus: 'local-only' })
            alert('You have been logged out because another session has started on the server.')
            window.location.reload()
            return
          }
        }
      } catch (e) {
        console.error('Failed to switch book', e)
        set({ serverSaveStatus: 'failed' })
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
    serverSaveStatus: 'local-only',
    setServerSaveStatus: (status) => set({ serverSaveStatus: status }),
    lastSyncedAt: null,
    syncToServer: async () => {
      const state = useAppStore.getState()
      if (!state.user) return

      set({ serverSaveStatus: 'saving' })
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
          set({ user: null, serverSaveStatus: 'local-only' })
          alert('You have been logged out because another session has started on the server.')
          window.location.reload()
        } else if (res.ok) {
          set({ serverSaveStatus: 'saved', lastSyncedAt: new Date().toISOString() })
        } else {
          set({ serverSaveStatus: 'failed' })
        }
      } catch {
        set({ serverSaveStatus: 'failed' })
      }
    },

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
        let errMsg = 'Login failed.'
        try {
          const contentType = res.headers.get('content-type')
          if (contentType && contentType.includes('application/json')) {
            const errData = await res.json()
            errMsg = errData.error || errData.detail || errMsg
          } else {
            const text = await res.text()
            if (text && text.trim().length > 0 && text.length < 200) {
              errMsg = text.trim()
            } else {
              errMsg = `Server error: HTTP ${res.status}`
            }
          }
        } catch {
          errMsg = `Server error: HTTP ${res.status}`
        }
        throw new Error(errMsg)
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
        let errMsg = 'Registration failed.'
        try {
          const contentType = res.headers.get('content-type')
          if (contentType && contentType.includes('application/json')) {
            const errData = await res.json()
            errMsg = errData.error || errData.detail || errMsg
          } else {
            const text = await res.text()
            if (text && text.trim().length > 0 && text.length < 200) {
              errMsg = text.trim()
            } else {
              errMsg = `Server error: HTTP ${res.status}`
            }
          }
        } catch {
          errMsg = `Server error: HTTP ${res.status}`
        }
        throw new Error(errMsg)
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
      // Clear IndexedDB cache to be completely secure and avoid PII leaks
      db.remove('web_canvas_documents')
      db.remove('web_canvas_versions')
      localStorage.removeItem('web_canvas_book_title')
      localStorage.removeItem('web_canvas_active_document_id')
      localStorage.removeItem('web_canvas_active_book_id')
      localStorage.removeItem('web_canvas_system_prompts_backup')
      localStorage.removeItem('web_canvas_providers_backup')
      localStorage.removeItem('web_canvas_theme')
      localStorage.removeItem('web_canvas_sidebar_open')
      localStorage.removeItem('web_canvas_debug_mode')
      localStorage.removeItem('web_canvas_active_provider')

      // Clear cookies that might have been set
      setCookie('__Secure-web_canvas_theme', '', -1)
      setCookie('__Secure-web_canvas_sidebar_open', '', -1)
      setCookie('__Secure-web_canvas_debug_mode', '', -1)
      setCookie('__Secure-web_canvas_active_provider', '', -1)
      setCookie('__Secure-web_canvas_system_prompts', '', -1)
      setCookie('__Secure-web_canvas_providers', '', -1)

      set({
        user: null,
        activeBookId: 'default',
        availableBooks: [],
        lastSyncedAt: null,
        customSystemPrompts: DEFAULT_SYSTEM_PROMPTS,
        activeSystemPromptId: 'prompt-none',
        providerConfigs: DEFAULT_CONFIGS,
        activeProvider: 'gemini',
        theme: 'dark',
        isSidebarOpen: true,
        debugMode: false,
        documents: MOCK_DOCUMENTS,
        activeDocumentId: 'doc-1',
        versions: [],
        messages: [
          {
            id: 'welcome',
            role: 'assistant',
            content: "Hello! I'm your Web Canvas assistant. You can write your document directly in the right panel, or tell me what you want to write and I can draft it for you. How can I help you today?",
            timestamp: new Date().toISOString(),
          },
        ]
      })
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

export const initializeStoreFromServer = async (forceRemoteSync = false) => {
  if (isInitialized && !forceRemoteSync) return

  // 1. Load local state from IndexedDB first (fast, zero network overhead)
  if (!isInitialized) {
    // Perform LocalStorage to IndexedDB migration if not done yet
    const isMigrated = localStorage.getItem('web_canvas_indexeddb_migrated') === 'true'
    if (!isMigrated) {
      try {
        const oldDocs = localStorage.getItem('web_canvas_documents')
        if (oldDocs) {
          await db.set('web_canvas_documents', JSON.parse(oldDocs))
          localStorage.removeItem('web_canvas_documents')
        }
        const oldVersions = localStorage.getItem('web_canvas_versions')
        if (oldVersions) {
          await db.set('web_canvas_versions', JSON.parse(oldVersions))
          localStorage.removeItem('web_canvas_versions')
        }
        localStorage.setItem('web_canvas_indexeddb_migrated', 'true')
        console.log('[Storage Migration] Successfully migrated heavy keys to IndexedDB.')
      } catch (migrationErr) {
        console.error('[Storage Migration] Migration failed:', migrationErr)
      }
    }

    // Load documents and versions from IndexedDB
    let loadedDocs: CanvasDocument[] | null = null
    let loadedVersions: DocumentVersion[] | null = null
    try {
      loadedDocs = await db.get<CanvasDocument[]>('web_canvas_documents')
      loadedVersions = await db.get<DocumentVersion[]>('web_canvas_versions')
    } catch (dbErr) {
      console.error('[IndexedDB] Failed to load data:', dbErr)
    }

    const documentsToSet = (loadedDocs && loadedDocs.length > 0) ? loadedDocs : MOCK_DOCUMENTS
    const versionsToSet = loadedVersions || []

    useAppStore.setState({
      documents: documentsToSet,
      versions: versionsToSet,
      selectedReferenceIds: documentsToSet.find(d => d.id === useAppStore.getState().activeDocumentId)?.selectedReferenceIds || []
    })

    // Set isStoreInitialized immediately so the UI boots up instantly using offline/local cache
    useAppStore.setState({ isStoreInitialized: true })
    isInitialized = true
  }

  const performSync = async () => {
    // 2. Fetch current session status in the background
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

    // 3. If not logged in, fetch available books list and stop here
    if (!loggedInUser) {
      await useAppStore.getState().fetchAvailableBooks()
      return
    }

    // 4. Continue initialization for logged-in user: fetch book state from server
    const activeBookId = localStorage.getItem('web_canvas_active_book_id') || 'default'

    useAppStore.setState({ serverSaveStatus: 'saving' })
    try {
      const res = await fetch(`/api/storage?bookId=${activeBookId}`)
      if (res.ok) {
        const serverData = await res.json()
        if (serverData && typeof serverData === 'object' && Object.keys(serverData).length > 0) {
          // Load server-side updates and boot
          const updates: Partial<AppState> = {}
          if (serverData.documents) {
            updates.documents = serverData.documents
            saveDocumentsToIndexedDB(serverData.documents, true)
          }
          if (serverData.versions) {
            updates.versions = serverData.versions
            safeIndexedDBSet('web_canvas_versions', serverData.versions)
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
            const currentConfigs = useAppStore.getState().providerConfigs || loadSavedConfigs()
            const mergedConfigs = mergeProviderConfigs(currentConfigs, serverData.providerConfigs)
            updates.providerConfigs = mergedConfigs
            saveConfigsToCookie(mergedConfigs)
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

          useAppStore.setState({ ...updates, serverSaveStatus: 'saved', lastSyncedAt: new Date().toISOString() })
        } else {
          // Server is empty, initialize server with initial client/default state
          const state = useAppStore.getState()
          const postRes = await fetch(`/api/storage?bookId=${activeBookId}`, {
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
          if (postRes.ok) {
            useAppStore.setState({ serverSaveStatus: 'saved', lastSyncedAt: new Date().toISOString() })
          } else {
            useAppStore.setState({ serverSaveStatus: 'failed' })
          }
        }
      } else {
        useAppStore.setState({ serverSaveStatus: 'failed' })
      }
    } catch (e) {
      console.error('Failed to load server data during initialization', e)
      useAppStore.setState({ serverSaveStatus: 'failed' })
    } finally {
      // Fetch available books list after sync is complete
      await useAppStore.getState().fetchAvailableBooks()
    }
  }

  if (forceRemoteSync) {
    await performSync()
  } else {
    // Execute asynchronously to allow render loop to run immediately
    performSync()
  }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null

interface SyncableState {
  documents: CanvasDocument[]
  versions: DocumentVersion[]
  bookTitle: string
  activeDocumentId: string
  activeProvider: LLMProvider
  providerConfigs: Record<LLMProvider, ProviderConfig>
  customSystemPrompts: SystemPromptTemplate[]
  activeSystemPromptId: string
  theme: 'dark' | 'light'
  messages: ChatMessage[]
  debugMode: boolean
}

let lastSyncableState: SyncableState = {
  documents: useAppStore.getState().documents,
  versions: useAppStore.getState().versions,
  bookTitle: useAppStore.getState().bookTitle,
  activeDocumentId: useAppStore.getState().activeDocumentId,
  activeProvider: useAppStore.getState().activeProvider,
  providerConfigs: useAppStore.getState().providerConfigs,
  customSystemPrompts: useAppStore.getState().customSystemPrompts,
  activeSystemPromptId: useAppStore.getState().activeSystemPromptId,
  theme: useAppStore.getState().theme,
  messages: useAppStore.getState().messages,
  debugMode: useAppStore.getState().debugMode,
}

const hasSyncableChanges = (state: AppState): boolean => {
  return (
    state.documents !== lastSyncableState.documents ||
    state.versions !== lastSyncableState.versions ||
    state.bookTitle !== lastSyncableState.bookTitle ||
    state.activeDocumentId !== lastSyncableState.activeDocumentId ||
    state.activeProvider !== lastSyncableState.activeProvider ||
    state.providerConfigs !== lastSyncableState.providerConfigs ||
    state.customSystemPrompts !== lastSyncableState.customSystemPrompts ||
    state.activeSystemPromptId !== lastSyncableState.activeSystemPromptId ||
    state.theme !== lastSyncableState.theme ||
    state.messages !== lastSyncableState.messages ||
    state.debugMode !== lastSyncableState.debugMode
  )
}

useAppStore.subscribe((state) => {
  if (!isInitialized) {
    lastSyncableState = {
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
      debugMode: state.debugMode,
    }
    return
  }
  if (!state.user) {
    if (useAppStore.getState().serverSaveStatus !== 'local-only') {
      useAppStore.setState({ serverSaveStatus: 'local-only' })
    }
    return // Don't auto-save if user is not logged in
  }

  if (!hasSyncableChanges(state)) {
    return // No syncable data changed (e.g. only serverSaveStatus, activeEditor, or selectedText changed)
  }

  lastSyncableState = {
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
    debugMode: state.debugMode,
  }

  if (useAppStore.getState().serverSaveStatus !== 'saving') {
    useAppStore.setState({ serverSaveStatus: 'saving' })
  }

  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(async () => {
    await useAppStore.getState().syncToServer()
  }, 3000) // 3-second debounce to accumulate edits and reduce server communication
})

