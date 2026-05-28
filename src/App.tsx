import { useState, useRef, useEffect } from 'react'
import { 
  Send, 
  Trash2, 
  Download, 
  Sun, 
  Moon, 
  History, 
  Sparkles, 
  BookOpen,
  Settings,
  RefreshCw,
  AlertCircle,
  Menu,
  Paperclip,
  X,
  Save,
  SquarePen,
  ChevronDown,
  ChevronUp,
  LogOut,
  Image,
  Cloud,
  CloudOff,
  CloudUpload,
  Square,
  Clipboard
} from 'lucide-react'
import { Editor } from './components/Editor'
import { SettingsModal } from './components/SettingsModal'
import { ChaptersSidebar } from './components/ChaptersSidebar'
import { AuthForm } from './components/AuthForm'
import { useAppStore, PROVIDER_MODELS } from './store/useAppStore'
import type { CanvasDocument, LLMProvider } from './store/useAppStore'
import { streamLLM } from './services/llm'
import type { LLMMessage } from './services/llm'
import { diffHtml } from './utils/diff'
import { htmlToMarkdown, htmlToPlainText } from './utils/convert'
import { DOMParser as ProseMirrorDOMParser, Node as ProseMirrorNode, Mark as ProseMirrorMark } from '@tiptap/pm/model'

// Fallback standard Gemini models
const FALLBACK_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b'
]

// Fallback standard Grok models
const FALLBACK_GROK_MODELS = [
  'grok-4.3',
  'grok-build-0.1',
  'grok-3',
  'grok-2',
  'grok-2-vision',
  'grok-beta'
]

function getTimestampId(prefix: string) {
  return `${prefix}-${Date.now()}`
}

function stripIncompleteEndTag(text: string): string {
  const target = '</selection_replace>'
  for (let i = target.length; i > 0; i--) {
    const prefix = target.substring(0, i)
    if (text.endsWith(prefix)) {
      return text.substring(0, text.length - prefix.length)
    }
  }
  return text
}

function countWords(html: string): number {
  if (!html) return 0
  
  // 1. Remove <del>...</del> tags and their contents (deleted text from diffs)
  let cleanText = html.replace(/<del\b[^>]*>([\s\S]*?)<\/del>/gi, '')
  
  // 2. Replace all other HTML tags with spaces
  cleanText = cleanText.replace(/<[^>]*>/g, ' ')
  
  // 3. Replace &nbsp; and other whitespace entities with standard spaces
  cleanText = cleanText.replace(/&nbsp;/g, ' ')
  
  // 4. Decode common HTML entities to avoid counting them as words
  cleanText = cleanText
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")

  // Match CJK characters (Chinese, Japanese, Korean)
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g
  const cjkCount = (cleanText.match(cjkRegex) || []).length
  
  // Remove CJK characters to count other words (Latin, Cyrillic, Arabic, etc.)
  const nonCjkText = cleanText.replace(cjkRegex, ' ')
  
  // Match words using unicode property escapes: letters and numbers, optionally with internal apostrophe/hyphen
  const wordRegex = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu
  const otherCount = (nonCjkText.match(wordRegex) || []).length
  
  return cjkCount + otherCount
}

const convertBlobUrlToDataUrl = async (blobUrl: string): Promise<string> => {
  try {
    const res = await fetch(blobUrl)
    const blob = await res.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch (err) {
    console.error('Failed to convert blob URL to data URL:', err)
    return blobUrl
  }
}

function App() {
  // Zustand store state
  const {
    theme,
    setTheme,
    documents,
    activeDocumentId,
    isSidebarOpen,
    selectedReferenceIds,
    updateActiveDocument,
    toggleReference,
    toggleSidebar,
    activeProvider,
    setProvider,
    providerConfigs,
    updateProviderConfig,
    availableGeminiModels,
    setAvailableGeminiModels,
    availableGrokModels,
    setAvailableGrokModels,
    messages,
    addMessage,
    clearChat,
    setMessages,
    isStreaming,
    setStreaming,
    customSystemPrompts,
    activeSystemPromptId,
    setActiveSystemPromptId,
    debugMode,
    selectedText,
    activeEditor,
    sessionInputTokens,
    sessionOutputTokens,
    sessionCacheHitTokens,
    sessionCacheMissTokens,
    addSessionTokens,
    resetSessionTokens,
    versions,
    createVersionSnapshot,
    restoreVersion,
    deleteVersionSnapshot,
    bookTitle,
    isStoreInitialized,
    serverSaveStatus,
    syncToServer,
    user,
    logout,
    activeBookId,
    switchBook,
    lastSyncedAt
  } = useAppStore()

  // Local UI state
  const [chatInput, setChatInput] = useState('')
  const [chatWidth, setChatWidth] = useState(380)
  const [isResizing, setIsResizing] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const getLayoutMode = (width: number, height: number): 'desktop' | 'portrait' | 'landscape' | 'tablet-square' => {
    if (width >= 1024) return 'desktop'
    if (width > height && height < 500) return 'landscape'
    const ratio = width / height
    if (ratio >= 0.75 && ratio <= 1.35) return 'tablet-square'
    return 'portrait'
  }

  const [layoutMode, setLayoutMode] = useState<'desktop' | 'portrait' | 'landscape' | 'tablet-square'>(
    getLayoutMode(window.innerWidth, window.innerHeight)
  )
  const [isChatExpanded, setIsChatExpanded] = useState(false)
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [isExportDropdownOpen, setIsExportDropdownOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [storageSize, setStorageSize] = useState('0.00 KB')

  // Revert & Edit Past Message state
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessageText, setEditingMessageText] = useState('')

  // Multimodal image upload states
  const [uploadedImages, setUploadedImages] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chatInputRef = useRef<HTMLDivElement>(null)

  const processFiles = (files: File[]) => {
    const validFiles = files.filter(file => file.type.startsWith('image/'))
    if (validFiles.length === 0) return

    if (uploadedImages.length + validFiles.length > 3) {
      alert('You can attach a maximum of 3 images.')
      return
    }

    validFiles.forEach(file => {
      if (file.size > 2 * 1024 * 1024) {
        alert(`Image "${file.name}" exceeds the 2MB size limit.`)
        return
      }
      const reader = new FileReader()
      reader.onload = (event) => {
        if (event.target?.result) {
          setUploadedImages(prev => [...prev, event.target!.result as string])
        }
      }
      reader.readAsDataURL(file)
    })
  }

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return
    const files = Array.from(e.target.files)
    processFiles(files)
    e.target.value = ''
  }

  const handlePaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    const files: File[] = []
    
    // Check e.clipboardData.files first (preferred by some mobile browsers)
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      for (let i = 0; i < e.clipboardData.files.length; i++) {
        const file = e.clipboardData.files[i]
        if (file && file.type.startsWith('image/')) {
          files.push(file)
        }
      }
    }
    
    // Fallback to e.clipboardData.items
    if (files.length === 0 && e.clipboardData.items) {
      const items = e.clipboardData.items
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile()
          if (file) {
            files.push(file)
          }
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault() // Prevent pasting image binary raw text
      processFiles(files)
      return
    }

    // Fallback for browsers that trigger paste event but do not expose inline clipboardData files
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const clipboardItems = await navigator.clipboard.read()
        const clipFiles: File[] = []
        for (const item of clipboardItems) {
          // Direct image types
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              try {
                const blob = await item.getType(type)
                const file = new File([blob], `pasted-image.${type.split('/')[1] || 'png'}`, { type })
                clipFiles.push(file)
              } catch (getTypeErr) {
                console.warn(`Failed to read type ${type} from inline paste fallback:`, getTypeErr)
              }
            }
          }
          // Fallback html image tags
          if (clipFiles.length === 0 && item.types.includes('text/html')) {
            try {
              const blob = await item.getType('text/html')
              const htmlText = await blob.text()
              const parser = new DOMParser()
              const doc = parser.parseFromString(htmlText, 'text/html')
              const imgs = Array.from(doc.getElementsByTagName('img'))
              for (const img of imgs) {
                const src = img.src
                if (src) {
                  if (src.startsWith('data:')) {
                    const res = await fetch(src)
                    const resBlob = await res.blob()
                    const file = new File([resBlob], 'pasted-image.png', { type: resBlob.type })
                    clipFiles.push(file)
                  } else if (src.startsWith('blob:')) {
                    const dataUrl = await convertBlobUrlToDataUrl(src)
                    const res = await fetch(dataUrl)
                    const resBlob = await res.blob()
                    const file = new File([resBlob], 'pasted-image.png', { type: resBlob.type })
                    clipFiles.push(file)
                  } else if (src.startsWith('http')) {
                    try {
                      const res = await fetch(src, { mode: 'cors' })
                      const resBlob = await res.blob()
                      const file = new File([resBlob], 'pasted-image.png', { type: resBlob.type })
                      clipFiles.push(file)
                    } catch (fetchErr) {
                      console.warn('Failed to fetch external inline image:', fetchErr)
                    }
                  }
                }
              }
            } catch (htmlErr) {
              console.warn('Failed to parse HTML from inline paste fallback:', htmlErr)
            }
          }
        }
        if (clipFiles.length > 0) {
          e.preventDefault()
          processFiles(clipFiles)
        }
      }
    } catch (err) {
      console.warn('Fallback Clipboard API read failed:', err)
    }
  }

  const handlePasteFromClipboard = async () => {
    // Check permission if query is supported
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const permission = await navigator.permissions.query({
          name: 'clipboard-read' as any
        })
        if (permission.state === 'denied') {
          alert('Clipboard read permission is denied. Please enable clipboard access for this site in your browser settings.')
          return
        }
      } catch (e) {
        // clipboard-read permission query might not be supported, ignore
      }
    }

    try {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        alert('Your browser does not support the clipboard reading API.')
        return
      }
      
      const clipboardItems = await navigator.clipboard.read()
      const files: File[] = []
      
      for (const item of clipboardItems) {
        // Direct image types
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            try {
              const blob = await item.getType(type)
              const file = new File([blob], `clipboard-image.${type.split('/')[1] || 'png'}`, { type })
              files.push(file)
            } catch (getTypeErr) {
              console.warn(`Failed to read type ${type} from clipboard:`, getTypeErr)
            }
          }
        }

        // Fallback: HTML content image tags
        if (files.length === 0 && item.types.includes('text/html')) {
          try {
            const blob = await item.getType('text/html')
            const htmlText = await blob.text()
            const parser = new DOMParser()
            const doc = parser.parseFromString(htmlText, 'text/html')
            const imgs = Array.from(doc.getElementsByTagName('img'))
            for (const img of imgs) {
              const src = img.src
              if (src) {
                if (src.startsWith('data:')) {
                  const res = await fetch(src)
                  const resBlob = await res.blob()
                  const file = new File([resBlob], 'clipboard-image.png', { type: resBlob.type })
                  files.push(file)
                } else if (src.startsWith('blob:')) {
                  const dataUrl = await convertBlobUrlToDataUrl(src)
                  const res = await fetch(dataUrl)
                  const resBlob = await res.blob()
                  const file = new File([resBlob], 'clipboard-image.png', { type: resBlob.type })
                  files.push(file)
                } else if (src.startsWith('http')) {
                  try {
                    const res = await fetch(src, { mode: 'cors' })
                    const resBlob = await res.blob()
                    const file = new File([resBlob], 'clipboard-image.png', { type: resBlob.type })
                    files.push(file)
                  } catch (fetchErr) {
                    console.warn('Failed to fetch external clipboard image:', fetchErr)
                  }
                }
              }
            }
          } catch (htmlErr) {
            console.warn('Failed to parse HTML from clipboard:', htmlErr)
          }
        }
      }
      
      if (files.length > 0) {
        processFiles(files)
      } else {
        alert('No image found in clipboard. Please make sure you have copied an image first.')
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err)
      alert('Could not read clipboard. Please ensure you copy an image and grant clipboard permissions.')
    }
  }

  // Text selection tracking refs for token optimization replacement
  const selectionRangeRef = useRef<{ from: number; to: number } | null>(null)
  const selectionEndRef = useRef<number | null>(null)
  const originalSelectedTextRef = useRef<string>('')
  const abortControllerRef = useRef<AbortController | null>(null)

  // Save status state
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved'>('saved')
  const saveTimeoutRef = useRef<number | null>(null)

  const triggerUnsaved = () => {
    setSaveStatus('unsaved')
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = window.setTimeout(() => {
      setSaveStatus('saved')
    }, 1500)
  }

  const forceSave = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    setSaveStatus('saved')
  }

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [])

  // Clear timeout and reset to saved when active document changes
  useEffect(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSaveStatus('saved')
  }, [activeDocumentId])

  // Calculate total localStorage usage in bytes, then format to KB
  const updateStorageSize = () => {
    let total = 0
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key) {
        total += (key.length + (localStorage.getItem(key) || '').length) * 2
      }
    }
    setStorageSize((total / 1024).toFixed(2) + ' KB')
  }

  // Update storage usage when documents, versions, theme or LLM configurations change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    updateStorageSize()
  }, [documents, versions, theme, providerConfigs])

  // Track window size for mobile responsive layouts
  useEffect(() => {
    const handleResize = () => {
      setLayoutMode(getLayoutMode(window.innerWidth, window.innerHeight))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // 1. Cross-Tab Sync: Listen to storage event to sync custom system prompts & LLM configs across tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'web_canvas_system_prompts_backup') {
        try {
          const parsed = e.newValue ? JSON.parse(e.newValue) : null
          if (parsed && parsed.version === 1) {
            useAppStore.setState({
              customSystemPrompts: parsed.prompts,
              activeSystemPromptId: parsed.activePromptId
            })
          }
        } catch (err) {
          console.error('Failed to sync system prompts from storage event', err)
        }
      } else if (e.key === 'web_canvas_providers_backup') {
        try {
          const parsed = e.newValue ? JSON.parse(e.newValue) : null
          if (parsed && parsed.version === 2) {
            useAppStore.setState({
              providerConfigs: parsed.data
            })
          }
        } catch (err) {
          console.error('Failed to sync LLM configs from storage event', err)
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  // 2. Cross-Device Sync: Fetch server books and check for modifications on tab focus/visibility change
  useEffect(() => {
    const checkServerUpdates = async () => {
      const state = useAppStore.getState()
      // Only check if user is logged in, there are no unsaved local changes, and we're not currently streaming or saving
      if (!state.user || state.serverSaveStatus !== 'saved' || state.isStreaming) return

      try {
        const res = await fetch('/api/books')
        if (res.ok) {
          const books = await res.json()
          useAppStore.setState({ availableBooks: books })
          
          const currentBook = books.find((b: any) => b.id === state.activeBookId)
          if (currentBook) {
            const serverUpdatedAt = currentBook.updatedAt
            const localLastSyncedAt = state.lastSyncedAt

            // If server's updatedAt is newer than local lastSyncedAt, trigger a book switch to pull latest data
            if (serverUpdatedAt && (!localLastSyncedAt || new Date(serverUpdatedAt) > new Date(localLastSyncedAt))) {
              console.log('Server changes detected. Syncing active book from server:', state.activeBookId)
              await state.switchBook(state.activeBookId)
            }
          }
        }
      } catch (err) {
        console.error('Failed to check server updates on focus', err)
      }
    }

    const handleFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        checkServerUpdates()
      }
    }

    window.addEventListener('focus', handleFocusOrVisible)
    document.addEventListener('visibilitychange', handleFocusOrVisible)

    return () => {
      window.removeEventListener('focus', handleFocusOrVisible)
      document.removeEventListener('visibilitychange', handleFocusOrVisible)
    }
  }, [activeBookId, switchBook, lastSyncedAt])

  // Dismiss export dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('#export-dropdown-trigger')) {
        setIsExportDropdownOpen(false)
      }
    }
    if (isExportDropdownOpen) {
      window.addEventListener('click', handleOutsideClick)
    }
    return () => {
      window.removeEventListener('click', handleOutsideClick)
    }
  }, [isExportDropdownOpen])



  const chatEndRef = useRef<HTMLDivElement>(null)
  const isResizingRef = useRef(false)
  const accumulatedTextRef = useRef('')

  // Retrieve active document
  const activeDoc = documents.find(d => d.id === activeDocumentId) || documents[0] || {
    id: 'default',
    title: 'Untitled Chapter',
    content: '<p>Start writing...</p>'
  }

  const activeConfig = providerConfigs[activeProvider]
  const geminiConfig = providerConfigs.gemini
  const geminiApiKey = geminiConfig.apiKey
  const geminiBaseUrl = geminiConfig.baseUrl
  const grokConfig = providerConfigs.grok
  const grokApiKey = grokConfig.apiKey
  const grokBaseUrl = grokConfig.baseUrl

  // Handle theme changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Fetch official Gemini models dynamically when API Key or Base URL changes
  useEffect(() => {
    const fetchOfficialModels = async () => {
      if (!geminiApiKey || geminiApiKey === 'ollama-no-key') {
        setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
        return
      }

      setIsLoadingModels(true)
      try {
        let url = `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`
        if (geminiBaseUrl && geminiBaseUrl !== 'https://generativelanguage.googleapis.com/v1beta') {
          url = `${geminiBaseUrl.replace(/\/$/, '')}/models?key=${geminiApiKey}`
        }

        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          if (data.models && Array.isArray(data.models)) {
            const filtered = data.models
              .filter((m: { name: string; supportedGenerationMethods?: string[] }) => 
                (m.supportedGenerationMethods?.includes('generateContent') || 
                 m.supportedGenerationMethods?.includes('streamGenerateContent')) &&
                !m.name.includes('embedding') &&
                !m.name.includes('aqa')
              )
              .map((m: { name: string }) => {
                return m.name.startsWith('models/') ? m.name.slice(7) : m.name
              })

            if (filtered.length > 0) {
              setAvailableGeminiModels(filtered)
              if (!filtered.includes(geminiConfig.model)) {
                updateProviderConfig('gemini', { model: filtered[0] })
              }
              setErrorMsg(null)
            } else {
              setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
              setErrorMsg('No compatible generation models returned from Gemini API.')
            }
          } else {
            setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
            setErrorMsg('Invalid model list response format from Gemini API.')
          }
        } else {
          setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
          setErrorMsg(`Failed to load official Gemini models: ${res.status} ${res.statusText}. Using fallback models.`)
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        console.error('Failed to fetch official Gemini models, using fallbacks', err)
        setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
        setErrorMsg(`Failed to connect to Gemini API: ${err.message}. Using fallback models.`)
      } finally {
        setIsLoadingModels(false)
      }
    }

    fetchOfficialModels()
  }, [geminiApiKey, geminiBaseUrl, setAvailableGeminiModels, updateProviderConfig, geminiConfig.model])

  // Fetch official Grok models dynamically when API Key or Base URL changes
  useEffect(() => {
    const fetchGrokModels = async () => {
      if (!grokApiKey) {
        setAvailableGrokModels(FALLBACK_GROK_MODELS)
        return
      }
      try {
        const url = `${grokBaseUrl.replace(/\/$/, '')}/models`
        const res = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${grokApiKey}`
          }
        })
        if (res.ok) {
          const data = await res.json()
          if (data.data && Array.isArray(data.data)) {
            const list = data.data
              .map((m: { id: string }) => m.id)
              .sort((a: string, b: string) => {
                if (a.startsWith('grok-3') && !b.startsWith('grok-3')) return -1
                if (!a.startsWith('grok-3') && b.startsWith('grok-3')) return 1
                return a.localeCompare(b)
              })
            if (list.length > 0) {
              setAvailableGrokModels(list)
              if (!list.includes(grokConfig.model)) {
                updateProviderConfig('grok', { model: list[0] })
              }
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch official Grok models', err)
      }
    }
    fetchGrokModels()
  }, [grokApiKey, grokBaseUrl, setAvailableGrokModels, updateProviderConfig, grokConfig.model])

  // Horizontal resizing handlers
  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    isResizingRef.current = true
    
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return
      
      const newWidth = Math.max(280, Math.min(600, e.clientX))
      setChatWidth(newWidth)
    }

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        setIsResizing(false)
        isResizingRef.current = false
        document.body.style.removeProperty('cursor')
        document.body.style.removeProperty('user-select')
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Static system prompt: contains only stable instructions that rarely change.
  // This maximizes LLM API prefix cache hits across consecutive requests.
  const buildStaticSystemPrompt = () => {
    const activePromptItem = customSystemPrompts.find(p => p.id === activeSystemPromptId) || customSystemPrompts[0]
    const customPromptText = activePromptItem?.content || ''

    return {
      role: 'system' as const,
      content: `You are an expert document writing and editing assistant.
You help the user write, edit, and polish the ACTIVE document shown on their screen.

${customPromptText ? `USER CUSTOM SYSTEM PROMPT / INSTRUCTIONAL GUIDELINES:\n${customPromptText}\n\n` : ''}CRITICAL RULES:
1. If your response updates the ACTIVE document, you have two options depending on scope:
   a. [PREFERRED FOR SELECTED EDITS]: If the user has selected text (provided in "CURRENT SELECTED TEXT IN ACTIVE DOCUMENT") and you are only updating/modifying that selection, output ONLY the updated selection content wrapped inside "<selection_replace>" XML tags. Do not output the rest of the document. This is highly preferred to save output tokens and speed up the reply.
   b. [FOR FULL DOCUMENT EDITS]: If you are rewriting the entire document or editing multiple non-contiguous parts of it, wrap the FULL updated document text inside "<canvas>" XML tags.
2. Write conversational feedback/explanations OUTSIDE the XML tags (either outside "<canvas>" or outside "<selection_replace>") for the chat panel.
3. Output the document content (inside "<canvas>" or "<selection_replace>") as clean HTML (using tags like h1, h2, h3, p, ul, ol, li, strong, em, blockquote, pre, code). You CAN output exactly one Heading 1 (<h1>) tag at the very beginning of a full document inside "<canvas>" to represent/change the chapter title. Do NOT output Heading 1 (<h1>) tags anywhere else; use Heading 2 (<h2>) or below for subsequent sections.
4. If the user instruction is just conversational and does not require updating the document, DO NOT output any XML block. Just write a conversational reply.`
    }
  }

  // Dynamic context: contains document content, references, selection etc.
  // Separated from system prompt so the stable prefix can be cached by LLM APIs.
  const buildDynamicContext = (finalReferenceIds: string[]) => {
    let referenceDocsContext = ''
    finalReferenceIds.forEach(refId => {
      const refDoc = documents.find(d => d.id === refId)
      if (refDoc) {
        referenceDocsContext += `\nREFERENCE DOCUMENT "${refDoc.title}" (READ-ONLY):\n"""\nTitle: ${refDoc.title}\nContent:\n${refDoc.content}\n"""\n`
      }
    })

    // Build overall project outline context
    const outlineList = documents
      .map(d => `- ${d.title}${d.id === activeDocumentId ? ' (Active / Editing Target)' : ''}`)
      .join('\n')

    // Construct selection context block
    const selectionContext = selectedText
      ? `\nCURRENT SELECTED TEXT IN ACTIVE DOCUMENT (Focus your edits ONLY on this section if the user instructs so):\n"""\n${selectedText}\n"""\n`
      : ''

    return {
      role: 'user' as const,
      content: `[DOCUMENT CONTEXT - Do not respond to this message directly, wait for the user's instruction in the next message.]

CHAPTER OUTLINE (OVERVIEW OF ALL WRITTEN CHAPTERS):
${outlineList}
${referenceDocsContext ? `\nREFERENCED DOCUMENT CONTEXTS (Read-only, do not modify these but use them for details/consistency):\n${referenceDocsContext}` : ''}
${selectionContext}
CURRENT ACTIVE DOCUMENT CONTENT (This is the ONLY document you can update):
"""
${activeDoc.content}
"""`
    }
  }

  // Shared LLM Streaming engine
  const startLLMStreaming = async (
    apiMessages: LLMMessage[],
    assistantMsgId: string,
    originalDocContent: string,
    attachmentsText: string,
    estimatedInputTokens: number
  ) => {
    // Abort any existing stream just in case
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    // Capture and store current selection indices before streaming starts
    if (activeEditor && selectedText) {
      selectionRangeRef.current = {
        from: activeEditor.state.selection.from,
        to: activeEditor.state.selection.to
      }
      selectionEndRef.current = activeEditor.state.selection.to
      originalSelectedTextRef.current = selectedText
    } else {
      selectionRangeRef.current = null
      selectionEndRef.current = null
      originalSelectedTextRef.current = ''
    }

    try {
      await streamLLM(
        apiMessages,
        { ...activeConfig, provider: activeProvider, debug: debugMode, signal },
        {
          onChunk: (chunk: string) => {
            accumulatedTextRef.current += chunk
            const raw = accumulatedTextRef.current

            let chatText: string
            let canvasText = ''
            let selectionReplaceText = ''
            let isSelectionEdit = false

            const canvasStart = '<canvas>'
            const canvasEnd = '</canvas>'
            const selectionStart = '<selection_replace>'
            const selectionEndTag = '</selection_replace>'

            const canvasIdx = raw.indexOf(canvasStart)
            const selectionIdx = raw.indexOf(selectionStart)

            if (selectionIdx !== -1) {
              isSelectionEdit = true
              chatText = raw.substring(0, selectionIdx).trim()
              const rest = raw.substring(selectionIdx + selectionStart.length)
              const endIdx = rest.indexOf(selectionEndTag)
              if (endIdx !== -1) {
                selectionReplaceText = rest.substring(0, endIdx)
                chatText += '\n\n' + rest.substring(endIdx + selectionEndTag.length).trim()
              } else {
                selectionReplaceText = rest
              }
            } else if (canvasIdx !== -1) {
              chatText = raw.substring(0, canvasIdx).trim()
              const rest = raw.substring(canvasIdx + canvasStart.length)
              const endIdx = rest.indexOf(canvasEnd)
              if (endIdx !== -1) {
                canvasText = rest.substring(0, endIdx)
                chatText += '\n\n' + rest.substring(endIdx + canvasEnd.length).trim()
              } else {
                canvasText = rest
              }
            } else {
              chatText = raw
            }

            // Prepend visual attachment details to conversational text
            const displayChatText = attachmentsText 
              ? `${attachmentsText}\n\n${chatText || 'Updating document...'}`
              : (chatText || 'Updating document...')

            // Update assistant message from fresh store state
            const latestMessages = useAppStore.getState().messages
            setMessages(
              latestMessages.map(m => {
                if (m.id === assistantMsgId) {
                  return {
                    ...m,
                    content: displayChatText
                  }
                }
                return m
              })
            )

            // Dynamic document insertion
            if (isSelectionEdit) {
              const cleanedText = stripIncompleteEndTag(selectionReplaceText)
              if (cleanedText && activeEditor && selectionRangeRef.current) {
                const { from } = selectionRangeRef.current
                const currentEnd = selectionEndRef.current ?? selectionRangeRef.current.to

                const tempDiv = document.createElement('div')
                tempDiv.innerHTML = cleanedText
                const slice = ProseMirrorDOMParser.fromSchema(activeEditor.state.schema).parseSlice(tempDiv)

                const tr = activeEditor.state.tr
                tr.replace(from, currentEnd, slice)
                activeEditor.view.dispatch(tr)

                selectionEndRef.current = from + slice.size
                updateActiveDocument({ content: activeEditor.getHTML() })
                setSaveStatus('unsaved')
              }
            } else if (canvasText.trim()) {
              updateActiveDocument({ content: canvasText })
              setSaveStatus('unsaved')
            }
          },
          onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }) => {
            setStreaming(false)

            // Calculate final response output tokens using API metadata or fallback estimations
            let finalInputTokens = estimatedInputTokens
            let finalOutputTokens = Math.ceil(fullText.length / 4)
            let cacheHits = 0

            if (usage) {
              finalInputTokens = usage.promptTokens
              finalOutputTokens = usage.completionTokens
              cacheHits = usage.cachedPromptTokens || 0
            }

            addSessionTokens(finalInputTokens, finalOutputTokens, cacheHits)

            let finalChatText: string
            let finalCanvasText = ''
            let finalSelectionReplaceText = ''
            let isSelectionEdit = false

            const canvasStart = '<canvas>'
            const canvasEnd = '</canvas>'
            const selectionStart = '<selection_replace>'
            const selectionEndTag = '</selection_replace>'

            const canvasIdx = fullText.indexOf(canvasStart)
            const selectionIdx = fullText.indexOf(selectionStart)

            if (selectionIdx !== -1) {
              isSelectionEdit = true
              finalChatText = fullText.substring(0, selectionIdx).trim()
              const rest = fullText.substring(selectionIdx + selectionStart.length)
              const endIdx = rest.indexOf(selectionEndTag)
              if (endIdx !== -1) {
                finalSelectionReplaceText = rest.substring(0, endIdx)
                finalChatText += '\n\n' + rest.substring(endIdx + selectionEndTag.length).trim()
              } else {
                finalSelectionReplaceText = rest
              }
            } else if (canvasIdx !== -1) {
              finalChatText = fullText.substring(0, canvasIdx).trim()
              const rest = fullText.substring(canvasIdx + canvasStart.length)
              const endIdx = rest.indexOf(canvasEnd)
              if (endIdx !== -1) {
                finalCanvasText = rest.substring(0, endIdx)
                finalChatText += '\n\n' + rest.substring(endIdx + canvasEnd.length).trim()
              } else {
                finalCanvasText = rest
              }
            } else {
              finalChatText = fullText
            }

            const displayChatText = attachmentsText 
              ? `${attachmentsText}\n\n${finalChatText.trim() || 'Document updated successfully.'}`
              : (finalChatText.trim() || 'Document updated successfully.')

            const latestMessages = useAppStore.getState().messages
            setMessages(
              latestMessages.map(m => {
                if (m.id === assistantMsgId) {
                  return {
                    ...m,
                    content: displayChatText
                  }
                }
                return m
              })
            )

            // Apply HTML-aware diff highlights on completion
            if (isSelectionEdit) {
              const cleanedText = stripIncompleteEndTag(finalSelectionReplaceText)
              if (cleanedText && activeEditor && selectionRangeRef.current) {
                const diffed = diffHtml(originalSelectedTextRef.current, cleanedText)
                const { from } = selectionRangeRef.current
                const currentEnd = selectionEndRef.current ?? selectionRangeRef.current.to

                const tempDiv = document.createElement('div')
                tempDiv.innerHTML = diffed
                const slice = ProseMirrorDOMParser.fromSchema(activeEditor.state.schema).parseSlice(tempDiv)

                const tr = activeEditor.state.tr
                tr.replace(from, currentEnd, slice)
                activeEditor.view.dispatch(tr)

                updateActiveDocument({ content: activeEditor.getHTML() })
              }
            } else if (finalCanvasText.trim()) {
              const diffed = diffHtml(originalDocContent, finalCanvasText)
              updateActiveDocument({ content: diffed })
            }
            forceSave()
          },
          onError: (err: Error) => {
            setStreaming(false)
            
            const isAbort = err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('cancel')
            if (isAbort) {
              // Keep the partial generated text! Just force save it.
              forceSave()
              return
            }

            setErrorMsg(err.message)
            
            const displayChatText = attachmentsText
              ? `${attachmentsText}\n\n⚠️ Error during stream: ${err.message}`
              : `⚠️ Error during stream: ${err.message}`

            const latestMessages = useAppStore.getState().messages
            setMessages(
              latestMessages.map(m => {
                if (m.id === assistantMsgId) {
                  return {
                    ...m,
                    content: displayChatText
                  }
                }
                return m
              })
            )

            // Revert document to original state before the edit attempt if error occurs
            updateActiveDocument({ content: originalDocContent })
            forceSave()
          }
        }
      )
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      setStreaming(false)
      setErrorMsg(err.message || 'Failed to initialize LLM stream.')
    }
  }

  // Send message handler (streaming and parsing)
  const handleSendMessage = async (e?: React.FormEvent, customPrompt?: string) => {
    e?.preventDefault()
    
    const promptText = customPrompt ? customPrompt.trim() : chatInput.trim()
    if (!promptText || isStreaming) return

    if (layoutMode === 'portrait') {
      setIsChatExpanded(true)
    }

    setErrorMsg(null)
    const originalDocContent = activeDoc.content
    
    // Create an auto-save snapshot before LLM modifications
    createVersionSnapshot(`Auto-save before: "${promptText.substring(0, 30)}${promptText.length > 30 ? '...' : ''}"`)
    
    if (!customPrompt) {
      setChatInput('')
      if (chatInputRef.current) {
        chatInputRef.current.innerHTML = ''
      }
    }

    // 1. Scan user prompt for other chapter title mentions to automatically attach them
    const autoDetectedIds: string[] = []
    documents.forEach(doc => {
      if (doc.id !== activeDocumentId) {
        // Strip Chapter numbering from titles for natural mention matching
        const cleanTitle = doc.title.toLowerCase().replace(/chapter\s*\d+\s*:\s*/g, '')
        if (
          promptText.toLowerCase().includes(doc.title.toLowerCase()) ||
          (cleanTitle.length > 3 && promptText.toLowerCase().includes(cleanTitle))
        ) {
          autoDetectedIds.push(doc.id)
        }
      }
    })

    // Combine manual selected reference IDs with auto-detected ones
    const finalReferenceIds = Array.from(new Set([...selectedReferenceIds, ...autoDetectedIds]))

    // 2. Add user message
    const userMsgId = getTimestampId('user')
    const userMsg = {
      id: userMsgId,
      role: 'user' as const,
      content: promptText,
      images: uploadedImages.length > 0 ? uploadedImages : undefined,
      timestamp: new Date().toISOString(),
      provider: activeProvider,
      model: activeConfig.model
    }
    addMessage(userMsg)
    setUploadedImages([])

    // 3. Add assistant placeholder
    const assistantMsgId = getTimestampId('assistant')
    const assistantPlaceholder = {
      id: assistantMsgId,
      role: 'assistant' as const,
      content: 'Thinking...',
      timestamp: new Date().toISOString(),
      provider: activeProvider,
      model: activeConfig.model
    }
    addMessage(assistantPlaceholder)
    setStreaming(true)

    accumulatedTextRef.current = ''

    // 4. Build messages: stable system prefix + dynamic context + history
    const staticSystem = buildStaticSystemPrompt()
    const dynamicContext = buildDynamicContext(finalReferenceIds)
    // Assistant acknowledgment bridges the context (user role) and chat history
    const contextAck: LLMMessage = { role: 'assistant', content: 'Understood. I have the document context. What would you like me to do?' }

    // Map chat history to LLM provider structure
    const historyMessages: LLMMessage[] = messages
      .filter(m => m.id !== 'welcome') // skip initial welcome for cleaner context
      .map(m => ({
        role: m.role,
        content: m.content,
        images: m.images
      }))

    // Add current user prompt
    historyMessages.push({
      role: 'user',
      content: promptText,
      images: userMsg.images
    })

    const apiMessages = [staticSystem, dynamicContext, contextAck, ...historyMessages]
    const estimatedInputTokens = Math.ceil(JSON.stringify(apiMessages).length / 4)

    // Construct visual attachment text indicators
    const attachmentsText = finalReferenceIds
      .map(id => {
        const doc = documents.find(d => d.id === id)
        return doc ? `[Attached Context: ${doc.title}]` : ''
      })
      .filter(Boolean)
      .join('\n')

    await startLLMStreaming(apiMessages, assistantMsgId, originalDocContent, attachmentsText, estimatedInputTokens)
  }

  // Edit and Resubmit message handler
  const handleResubmitMessage = async (msgId: string, newContent: string) => {
    const trimmed = newContent.trim()
    if (!trimmed || isStreaming) return

    if (layoutMode === 'portrait') {
      setIsChatExpanded(true)
    }

    setEditingMessageId(null)
    setErrorMsg(null)

    // Find the message index
    const targetIdx = messages.findIndex(m => m.id === msgId)
    if (targetIdx === -1) return

    // Truncate message history from target message index, replacing the edited content
    const truncatedMessages = messages.slice(0, targetIdx + 1).map((m, idx) => {
      if (idx === targetIdx) {
        return {
          ...m,
          content: trimmed,
          timestamp: new Date().toISOString()
        }
      }
      return m
    })

    const originalDocContent = activeDoc.content
    createVersionSnapshot(`Auto-save before edit: "${trimmed.substring(0, 30)}${trimmed.length > 30 ? '...' : ''}"`)

    // Update store state with truncated history
    setMessages(truncatedMessages)

    // Add new assistant reply placeholder
    const assistantMsgId = getTimestampId('assistant')
    const assistantPlaceholder = {
      id: assistantMsgId,
      role: 'assistant' as const,
      content: 'Thinking...',
      timestamp: new Date().toISOString(),
      provider: activeProvider,
      model: activeConfig.model
    }
    setMessages([...truncatedMessages, assistantPlaceholder])
    setStreaming(true)

    accumulatedTextRef.current = ''

    // Scan user prompt for other chapter title mentions
    const autoDetectedIds: string[] = []
    documents.forEach(doc => {
      if (doc.id !== activeDocumentId) {
        const cleanTitle = doc.title.toLowerCase().replace(/chapter\s*\d+\s*:\s*/g, '')
        if (
          trimmed.toLowerCase().includes(doc.title.toLowerCase()) ||
          (cleanTitle.length > 3 && trimmed.toLowerCase().includes(cleanTitle))
        ) {
          autoDetectedIds.push(doc.id)
        }
      }
    })

    const finalReferenceIds = Array.from(new Set([...selectedReferenceIds, ...autoDetectedIds]))

    // Build messages: stable system prefix + dynamic context + history
    const staticSystem = buildStaticSystemPrompt()
    const dynamicContext = buildDynamicContext(finalReferenceIds)
    const contextAck: LLMMessage = { role: 'assistant', content: 'Understood. I have the document context. What would you like me to do?' }

    // Map history to provider messages
    const historyMessages: LLMMessage[] = truncatedMessages
      .filter(m => m.id !== 'welcome')
      .map(m => ({
        role: m.role,
        content: m.content,
        images: m.images
      }))

    const apiMessages = [staticSystem, dynamicContext, contextAck, ...historyMessages]
    const estimatedInputTokens = Math.ceil(JSON.stringify(apiMessages).length / 4)

    const attachmentsText = finalReferenceIds
      .map(id => {
        const doc = documents.find(d => d.id === id)
        return doc ? `[Attached Context: ${doc.title}]` : ''
      })
      .filter(Boolean)
      .join('\n')

    await startLLMStreaming(apiMessages, assistantMsgId, originalDocContent, attachmentsText, estimatedInputTokens)
  }

  const hasPendingDiffs = activeDoc.content.includes('data-diff-id')

  // Accept all additions and finalize all deletions in active document
  const handleAcceptAllDiffs = () => {
    if (activeEditor) {
      const { state, view } = activeEditor
      const { doc } = state
      const tr = state.tr
      const changes: { from: number; to: number; type: 'addition' | 'deletion' }[] = []

      doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (node.isText) {
          node.marks.forEach((mark: ProseMirrorMark) => {
            if (mark.type.name === 'diffAddition' || mark.type.name === 'diffDeletion') {
              changes.push({
                from: pos,
                to: pos + node.nodeSize,
                type: mark.type.name === 'diffAddition' ? 'addition' : 'deletion'
              })
            }
          })
        }
      })

      changes.sort((a, b) => b.from - a.from)
      changes.forEach(change => {
        if (change.type === 'addition') {
          tr.removeMark(change.from, change.to, state.schema.marks.diffAddition)
        } else {
          tr.delete(change.from, change.to)
        }
      })
      view.dispatch(tr)
      updateActiveDocument({ content: activeEditor.getHTML() })
    } else {
      const cleaned = activeDoc.content
        .replace(/<ins[^>]*data-diff-id="[^"]*"[^>]*>([\s\S]*?)<\/ins>/g, '$1')
        .replace(/<del[^>]*data-diff-id="[^"]*"[^>]*>([\s\S]*?)<\/del>/g, '')
      updateActiveDocument({ content: cleaned })
    }
    triggerUnsaved()
  }

  // Reject all additions and restore all deleted text in active document
  const handleRejectAllDiffs = () => {
    if (activeEditor) {
      const { state, view } = activeEditor
      const { doc } = state
      const tr = state.tr
      const changes: { from: number; to: number; type: 'addition' | 'deletion' }[] = []

      doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (node.isText) {
          node.marks.forEach((mark: ProseMirrorMark) => {
            if (mark.type.name === 'diffAddition' || mark.type.name === 'diffDeletion') {
              changes.push({
                from: pos,
                to: pos + node.nodeSize,
                type: mark.type.name === 'diffAddition' ? 'addition' : 'deletion'
              })
            }
          })
        }
      })

      changes.sort((a, b) => b.from - a.from)
      changes.forEach(change => {
        if (change.type === 'addition') {
          tr.delete(change.from, change.to)
        } else {
          tr.removeMark(change.from, change.to, state.schema.marks.diffDeletion)
        }
      })
      view.dispatch(tr)
      updateActiveDocument({ content: activeEditor.getHTML() })
    } else {
      const cleaned = activeDoc.content
        .replace(/<ins[^>]*data-diff-id="[^"]*"[^>]*>([\s\S]*?)<\/ins>/g, '')
        .replace(/<del[^>]*data-diff-id="[^"]*"[^>]*>([\s\S]*?)<\/del>/g, '$1')
      updateActiveDocument({ content: cleaned })
    }
    triggerUnsaved()
  }

  // Route editor selection quick action toolbar commands to LLM
  const handleQuickAction = async (action: 'rewrite' | 'shorten' | 'expand' | 'grammar') => {
    let prompt = ''
    switch (action) {
      case 'rewrite':
        prompt = 'Rewrite the selected text to make it flow better and sound more professional.'
        break
      case 'shorten':
        prompt = 'Make the selected text more concise and to the point.'
        break
      case 'expand':
        prompt = 'Elaborate on the selected text, adding more detail and depth.'
        break
      case 'grammar':
        prompt = 'Fix any spelling, grammar, or punctuation errors in the selected text.'
        break
    }
    await handleSendMessage(undefined, prompt)
  }

  // Clear chat handler
  const handleClearChat = () => {
    clearChat()
    resetSessionTokens()
  }

  // Toggle theme helper
  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }

  // Export document handler
  const handleExport = (format: 'html' | 'markdown' | 'txt', exportAll: boolean) => {
    const element = document.createElement("a")
    let content = ''
    let filename: string
    let mimeType: string
    
    const cleanBookTitle = bookTitle.trim().replace(/[/\\?%*:|"<>\s]+/g, '_').replace(/_+/g, '_') || 'Book'
    const cleanChapterTitle = activeDoc.title.trim().replace(/[/\\?%*:|"<>\s]+/g, '_').replace(/_+/g, '_') || 'Chapter'
    const baseFilename = exportAll 
      ? cleanBookTitle 
      : `${cleanBookTitle}_${cleanChapterTitle}`


    if (format === 'html') {
      let bodyContent = ''
      if (exportAll) {
        documents.forEach((doc, idx) => {
          const contentTrimmed = doc.content.trim()
          const startsWithH1 = contentTrimmed.startsWith('<h1') || contentTrimmed.startsWith('<h1>')
          if (startsWithH1) {
            bodyContent += `${doc.content}\n`
          } else {
            bodyContent += `<h1>${doc.title}</h1>\n${doc.content}\n`
          }
          if (idx < documents.length - 1) {
            bodyContent += `<hr style="margin: 3rem 0; border: none; border-top: 1px solid #cbd5e1;" />\n`
          }
        })
      } else {
        bodyContent = activeDoc.content
      }

      content = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${exportAll ? 'All Chapters Combined' : activeDoc.title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #1e293b; max-width: 740px; margin: 2rem auto; padding: 0 1rem; }
    h1, h2, h3 { color: #0f172a; }
    blockquote { border-left: 4px solid #f59e0b; padding-left: 1rem; font-style: italic; color: #475569; }
    pre { background-color: #f1f5f9; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    code { font-family: monospace; background-color: #f1f5f9; padding: 0.2rem 0.4rem; border-radius: 4px; }
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`
      filename = `${baseFilename}.html`
      mimeType = 'text/html'
    } else if (format === 'markdown') {
      if (exportAll) {
        documents.forEach((doc, idx) => {
          const markdownContent = htmlToMarkdown(doc.content)
          const startsWithH1 = markdownContent.trim().startsWith('# ')
          if (startsWithH1) {
            content += `${markdownContent}\n`
          } else {
            content += `# ${doc.title}\n\n${markdownContent}\n`
          }
          if (idx < documents.length - 1) {
            content += `\n---\n\n`
          }
        })
      } else {
        content = htmlToMarkdown(activeDoc.content)
      }
      filename = `${baseFilename}.md`
      mimeType = 'text/markdown'
    } else {
      if (exportAll) {
        documents.forEach((doc, idx) => {
          const plainTextContent = htmlToPlainText(doc.content)
          const lines = plainTextContent.trim().split('\n')
          const startsWithHeading = lines.length > 1 && lines[1].trim().length > 0 && /^[=]+$/.test(lines[1].trim())
          if (startsWithHeading) {
            content += `${plainTextContent}\n`
          } else {
            content += `${doc.title}\n${'='.repeat(doc.title.length)}\n\n${plainTextContent}\n`
          }
          if (idx < documents.length - 1) {
            content += `\n\n\n`
          }
        })
      } else {
        content = htmlToPlainText(activeDoc.content)
      }
      filename = `${baseFilename}.txt`
      mimeType = 'text/plain'
    }

    const file = new Blob([content], { type: mimeType })
    element.href = URL.createObjectURL(file)
    element.download = filename
    document.body.appendChild(element)
    element.click()
    document.body.removeChild(element)
  }

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    updateProviderConfig(activeProvider, { model: e.target.value })
  }

  const getAvailableModels = () => {
    if (activeProvider === 'gemini') {
      return availableGeminiModels
    }
    if (activeProvider === 'grok') {
      return availableGrokModels
    }
    return PROVIDER_MODELS[activeProvider] || []
  }

  const getProviderLabel = (prov: string) => {
    return prov === 'grok' ? 'Grok' : prov.charAt(0).toUpperCase() + prov.slice(1)
  }

  const getResponderName = (msg: typeof messages[0]) => {
    if (msg.role === 'user') return 'You'
    const prov = msg.provider || activeProvider
    const model = msg.model || activeConfig.model
    return `${getProviderLabel(prov)} (${model})`
  }

  if (!isStoreInitialized) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        width: '100%',
        backgroundColor: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        gap: '1.5rem',
        fontFamily: 'system-ui, sans-serif'
      }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="animate-spin" style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            border: '3px solid var(--border-color)',
            borderTopColor: 'var(--accent)'
          }} />
          <Sparkles size={20} style={{ position: 'absolute', color: 'var(--accent)' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>Materializing Canvas</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>Checking workspace storage connection...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <AuthForm />
  }

  return (
    <div className={`app-container layout-${layoutMode}`}>
      {/* Top Application Bar */}
      <header className="app-header">
        <div className="app-header-left">
          {/* Sidebar Toggle Button if collapsed */}
          {!isSidebarOpen && (
            <button 
              onClick={toggleSidebar} 
              className="btn-icon" 
              title="Open Chapters Sidebar"
              type="button"
              style={{ marginRight: '0.5rem' }}
            >
              <Menu size={18} />
            </button>
          )}

          <div className="app-logo">
            <Sparkles size={20} style={{ color: 'var(--accent)' }} />
            Web <span>Canvas</span>
          </div>
        </div>

        <div className="app-header-right">
          {/* Provider Selector Dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Provider:</span>
            <select
              className="select-styled"
              value={activeProvider}
              onChange={(e) => setProvider(e.target.value as LLMProvider)}
              title="Select LLM Provider"
            >
              <option value="gemini">Gemini</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="ollama">Ollama</option>
              <option value="grok">Grok (xAI)</option>
            </select>
          </div>

          {/* Dynamic Model Selector Dropdown */}
          {layoutMode !== 'portrait' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Model:</span>
              <select 
                className="select-styled" 
                value={activeConfig.model} 
                onChange={handleModelChange}
                title={`Select ${activeProvider} Model`}
                disabled={activeProvider === 'gemini' && isLoadingModels}
              >
                {getAvailableModels().map(model => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              {activeProvider === 'gemini' && isLoadingModels && (
                <RefreshCw size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
              )}
            </div>
          )}

          {/* System Prompt Selector Dropdown */}
          {layoutMode !== 'portrait' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Prompt:</span>
              <select 
                className="select-styled" 
                value={activeSystemPromptId} 
                onChange={(e) => setActiveSystemPromptId(e.target.value)}
                title="Select System Prompt Preset"
              >
                {customSystemPrompts.map(prompt => (
                  <option key={prompt.id} value={prompt.id}>
                    {prompt.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Settings Button */}
          <button 
            onClick={() => setIsSettingsOpen(true)} 
            className="btn-icon" 
            title={`Open ${activeProvider} Settings`}
            type="button"
          >
            <Settings size={18} />
          </button>

          {/* Theme Switcher */}
          <button 
            onClick={toggleTheme} 
            className="btn-icon" 
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            type="button"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          {/* User Profile & Logout */}
          {user && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.25rem', borderLeft: '1px solid var(--border-color)', paddingLeft: '0.75rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                Hi, <strong style={{ color: 'var(--text-primary)' }}>{user.username}</strong>
              </span>
              <button
                onClick={async () => {
                  if (window.confirm('Are you sure you want to log out?')) {
                    await logout()
                    window.location.reload()
                  }
                }}
                className="btn-icon"
                title="Log Out"
                type="button"
                style={{ color: '#ef4444' }}
              >
                <LogOut size={16} />
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main split work area */}
      <main className="app-main">
        {/* Chapters Left Sidebar */}
        <ChaptersSidebar />

        {/* Sidebar Backdrop overlays for mobile drawer dismissal */}
        {isSidebarOpen && layoutMode !== 'desktop' && (
          <div 
            className="sidebar-backdrop" 
            onClick={toggleSidebar} 
          />
        )}
        {isHistoryOpen && layoutMode !== 'desktop' && (
          <div 
            className="sidebar-backdrop" 
            onClick={() => setIsHistoryOpen(false)} 
          />
        )}

        {/* Resizable Chat Panel */}
        <section 
          className={`chat-panel ${isChatExpanded ? 'expanded' : ''}`} 
            style={{ 
              width: layoutMode === 'portrait' 
                ? '100%' 
                : layoutMode === 'landscape' 
                ? '40%' 
                : layoutMode === 'tablet-square' 
                ? '45%' 
                : `${chatWidth}px` 
            }}
          >
            <div className="chat-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {layoutMode === 'portrait' && (
                  <button 
                    onClick={() => setIsChatExpanded(false)} 
                    className="btn-icon" 
                    title="Collapse chat history"
                    type="button"
                  >
                    <ChevronDown size={18} />
                  </button>
                )}
                <h2>Assistant Chat ({getProviderLabel(activeProvider)})</h2>
              </div>
              <button 
                onClick={handleClearChat} 
                className="btn-icon" 
                title="Clear chat history"
                type="button"
              >
                <Trash2 size={16} />
              </button>
            </div>

            <div className="chat-messages">
              {messages.map(msg => (
                <div key={msg.id} className={`chat-message ${msg.role}`}>
                  {editingMessageId === msg.id ? (
                    <div className="chat-message-edit-container">
                      <textarea
                        value={editingMessageText}
                        onChange={(e) => setEditingMessageText(e.target.value)}
                        className="chat-message-edit-textarea"
                      />
                      <div className="chat-message-edit-actions">
                        <button
                          onClick={() => setEditingMessageId(null)}
                          className="btn-secondary"
                          type="button"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleResubmitMessage(msg.id, editingMessageText)}
                          className="btn-primary"
                          type="button"
                        >
                          Save & Submit
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="chat-message-bubble">
                        {msg.images && msg.images.length > 0 && (
                          <div className="chat-message-images" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
                            {msg.images.map((img, idx) => (
                              <img 
                                key={idx} 
                                src={img} 
                                alt={`Attachment ${idx + 1}`} 
                                style={{ 
                                  maxWidth: '120px', 
                                  maxHeight: '120px', 
                                  borderRadius: '6px', 
                                  objectFit: 'cover',
                                  border: '1px solid var(--border-color)' 
                                }} 
                              />
                            ))}
                          </div>
                        )}
                        <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                      </div>
                      <span className="chat-message-info" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                        <span>{getResponderName(msg)} • {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {msg.role === 'user' && editingMessageId !== msg.id && !isStreaming && (
                          <button
                            onClick={() => {
                              setEditingMessageId(msg.id)
                              setEditingMessageText(msg.content)
                            }}
                            className="btn-icon"
                            title="Edit message"
                            type="button"
                            style={{ padding: '0.1rem', background: 'transparent', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', opacity: 0.6 }}
                            onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                            onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
                          >
                            <SquarePen size={12} />
                          </button>
                        )}
                      </span>
                    </>
                  )}
                </div>
              ))}
              {isStreaming && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  <RefreshCw size={12} className="animate-spin" />
                  <span>{getProviderLabel(activeProvider)} is streaming changes...</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {errorMsg && (
              <div style={{
                margin: '0.75rem',
                padding: '0.75rem',
                borderRadius: '8px',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#f87171',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <AlertCircle size={16} style={{ flexShrink: 0 }} />
                  <span>{errorMsg}</span>
                </div>
                <button 
                  onClick={() => setErrorMsg(null)} 
                  className="btn-icon" 
                  title="Dismiss error"
                  type="button"
                  style={{ padding: '2px', color: '#f87171' }}
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Reference Document Context Attach Bar */}
            {documents.length > 1 && (
              <div className="reference-selector-bar">
                <span className="reference-title-label">
                  <Paperclip size={10} /> Reference Context (Optional):
                </span>
                {documents
                  .filter(doc => doc.id !== activeDocumentId)
                  .map(doc => {
                    const isSelected = selectedReferenceIds.includes(doc.id)
                    return (
                      <button
                        key={doc.id}
                        onClick={() => toggleReference(doc.id)}
                        className={`reference-tag ${isSelected ? 'active' : ''}`}
                        disabled={isStreaming}
                        type="button"
                      >
                        {doc.title}
                      </button>
                    )
                  })
                }
              </div>
            )}

            <form onSubmit={handleSendMessage} className="chat-input-container">
              {uploadedImages.length > 0 && (
                <div className="chat-upload-previews" style={{ 
                  display: 'flex', 
                  gap: '8px', 
                  padding: '8px 12px', 
                  flexWrap: 'wrap',
                  border: '1px solid var(--border-color)',
                  borderBottom: 'none',
                  backgroundColor: 'var(--bg-tertiary)',
                  borderTopLeftRadius: '10px',
                  borderTopRightRadius: '10px',
                  marginBottom: '-1px'
                }}>
                  {uploadedImages.map((img, idx) => (
                    <div key={idx} style={{ position: 'relative', display: 'inline-block' }}>
                      <img 
                        src={img} 
                        alt="Upload preview" 
                        className="chat-upload-preview-img"
                      />
                      <button
                        type="button"
                        onClick={() => setUploadedImages(prev => prev.filter((_, i) => i !== idx))}
                        style={{
                          position: 'absolute',
                          top: '-4px',
                          right: '-4px',
                          backgroundColor: 'rgba(239, 68, 68, 0.9)',
                          color: 'white',
                          border: 'none',
                          borderRadius: '50%',
                          width: '16px',
                          height: '16px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '8px',
                          cursor: 'pointer',
                          padding: 0
                        }}
                      >
                        <X size={8} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="chat-input-wrapper" style={{
                borderTopLeftRadius: uploadedImages.length > 0 ? '0px' : undefined,
                borderTopRightRadius: uploadedImages.length > 0 ? '0px' : undefined
              }}>
                {layoutMode === 'portrait' && (
                  <button
                    type="button"
                    onClick={() => setIsChatExpanded(!isChatExpanded)}
                    className={`btn-icon chat-expand-toggle-btn ${isChatExpanded ? 'expanded' : ''}`}
                    title={isChatExpanded ? "Collapse Chat History" : "Expand Chat History"}
                    style={{ marginRight: '0.25rem', padding: '0.25rem' }}
                  >
                    {isChatExpanded ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                  </button>
                )}
                <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
                  <div
                    ref={chatInputRef}
                    contentEditable={!isStreaming}
                    onInput={async e => {
                      const container = e.currentTarget
                      const imgs = Array.from(container.getElementsByTagName('img'))
                      if (imgs.length > 0) {
                        const newImages: string[] = []
                        for (const img of imgs) {
                          const src = img.src
                          if (src) {
                            if (src.startsWith('blob:')) {
                              try {
                                const dataUrl = await convertBlobUrlToDataUrl(src)
                                newImages.push(dataUrl)
                              } catch (err) {
                                console.error('Failed to convert blob URL:', err)
                              }
                            } else {
                              newImages.push(src)
                            }
                          }
                          img.remove()
                        }
                        if (newImages.length > 0) {
                          setUploadedImages(prev => {
                            if (prev.length + newImages.length > 3) {
                              alert('You can attach a maximum of 3 images.')
                              return prev
                            }
                            return [...prev, ...newImages]
                          })
                        }
                      }
                      setChatInput(container.innerText || '')
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSendMessage()
                      }
                    }}
                    onPaste={handlePaste}
                    className="chat-textarea"
                    style={{
                      overflowY: 'auto',
                      minHeight: '24px',
                      maxHeight: '120px',
                      userSelect: 'text',
                      WebkitUserSelect: 'text',
                      outline: 'none',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      width: '100%'
                    }}
                  />
                  {!chatInput && (
                    <span 
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        color: 'var(--text-muted)',
                        pointerEvents: 'none',
                        userSelect: 'none',
                        fontStyle: 'normal'
                      }}
                    >
                      {`Instruct ${activeProvider === 'grok' ? 'Grok' : activeProvider.charAt(0).toUpperCase() + activeProvider.slice(1)} (${activeConfig.model})...`}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn-icon"
                  title="Upload image"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming}
                  style={{ padding: '0.5rem', color: 'var(--text-secondary)' }}
                >
                  <Image size={18} />
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  title="Paste image from clipboard"
                  onClick={handlePasteFromClipboard}
                  disabled={isStreaming}
                  style={{ padding: '0.5rem', color: 'var(--text-secondary)' }}
                >
                  <Clipboard size={18} />
                </button>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleImageUpload}
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                />
                {isStreaming ? (
                  <button 
                    type="button" 
                    className="btn-icon animate-pulse" 
                    title="Stop generation"
                    onClick={() => {
                      abortControllerRef.current?.abort()
                    }}
                    style={{ 
                      color: '#ef4444',
                      cursor: 'pointer'
                    }}
                  >
                    <Square size={16} fill="#ef4444" />
                  </button>
                ) : (
                  <button 
                    type="submit" 
                    className="btn-icon" 
                    title="Send instruction"
                    disabled={!chatInput.trim() && uploadedImages.length === 0}
                    style={{ 
                      color: (chatInput.trim() || uploadedImages.length > 0) ? 'var(--accent)' : 'var(--text-muted)',
                      cursor: (chatInput.trim() || uploadedImages.length > 0) ? 'pointer' : 'default'
                    }}
                  >
                    <Send size={18} />
                  </button>
                )}
              </div>
            </form>
          </section>

        {/* Resizing Divider Gutter */}
        {layoutMode === 'desktop' && (
          <div 
            className={`resize-handle ${isResizing ? 'active' : ''}`}
            onMouseDown={startResizing}
          />
        )}

        {/* Right Side: Document Canvas Panel */}
        <section className="canvas-panel" style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '100%', overflow: 'hidden' }}>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', overflow: 'hidden' }}>
              <div className="canvas-header">
                <div className="canvas-title-wrapper">
                  <BookOpen size={16} style={{ color: 'var(--text-secondary)' }} />
                  <input
                    type="text"
                    value={activeDoc.title}
                    onChange={e => {
                      triggerUnsaved()
                      updateActiveDocument({ title: e.target.value })
                    }}
                    className="canvas-title-input"
                    placeholder="Untitled Document"
                    title="Document Title"
                    disabled={isStreaming}
                    style={{
                      cursor: isStreaming ? 'not-allowed' : 'text',
                      opacity: isStreaming ? 0.6 : 1
                    }}
                  />
                </div>
                
                <div className="canvas-actions">
                  {/* Local Save Status Button */}
                  <button
                    onClick={() => {
                      if (saveStatus === 'unsaved') {
                        forceSave()
                      }
                    }}
                    className={`btn-icon ${saveStatus === 'unsaved' ? 'is-dirty' : ''}`}
                    title={
                      saveStatus === 'unsaved'
                        ? 'Unsaved changes in browser (autosaving locally...)'
                        : 'All edits saved to local browser storage'
                    }
                    type="button"
                    style={{
                      color: saveStatus === 'unsaved' ? 'var(--accent)' : '#10b981',
                      cursor: saveStatus === 'unsaved' ? 'pointer' : 'default',
                    }}
                  >
                    {saveStatus === 'unsaved' ? (
                      <RefreshCw size={18} className="animate-spin" />
                    ) : (
                      <Save size={18} />
                    )}
                  </button>

                  {/* Server Sync Status Indicator */}
                  <button
                    onClick={() => {
                      if (serverSaveStatus === 'failed') {
                        syncToServer()
                      }
                    }}
                    className={`btn-icon ${serverSaveStatus === 'saving' ? 'is-dirty' : ''} ${serverSaveStatus === 'failed' ? 'has-error' : ''}`}
                    title={
                      serverSaveStatus === 'saved'
                        ? 'All changes synced to cloud server'
                        : serverSaveStatus === 'saving'
                        ? 'Syncing changes to cloud server...'
                        : serverSaveStatus === 'failed'
                        ? 'Sync failed (server offline). Click to retry.'
                        : 'Local-only mode (log in to sync with cloud)'
                    }
                    type="button"
                    style={{
                      color:
                        serverSaveStatus === 'saved'
                          ? '#10b981'
                          : serverSaveStatus === 'saving'
                          ? 'var(--accent)'
                          : serverSaveStatus === 'failed'
                          ? '#ef4444'
                          : 'var(--text-muted)',
                      cursor: serverSaveStatus === 'failed' ? 'pointer' : 'default',
                      opacity: serverSaveStatus === 'local-only' ? 0.4 : 1,
                    }}
                  >
                    {serverSaveStatus === 'saving' ? (
                      <CloudUpload size={18} className="animate-pulse" />
                    ) : serverSaveStatus === 'failed' ? (
                      <CloudOff size={18} />
                    ) : serverSaveStatus === 'local-only' ? (
                      <CloudOff size={18} />
                    ) : (
                      <Cloud size={18} />
                    )}
                  </button>

                  <button 
                    onClick={() => setIsHistoryOpen(!isHistoryOpen)} 
                    className={`btn-icon ${isHistoryOpen ? 'active' : ''}`} 
                    title="View snapshots history" 
                    type="button"
                    style={{ color: isHistoryOpen ? 'var(--accent)' : 'inherit' }}
                  >
                    <History size={18} />
                  </button>
                  
                  {/* Export Dropdown relative wrapper */}
                  <div style={{ position: 'relative', display: 'inline-block' }}>
                    <button 
                      onClick={() => setIsExportDropdownOpen(!isExportDropdownOpen)} 
                      className={`btn-icon ${isExportDropdownOpen ? 'active' : ''}`} 
                      title="Export document"
                      type="button"
                      id="export-dropdown-trigger"
                    >
                      <Download size={18} />
                    </button>
                    {isExportDropdownOpen && (
                      <div 
                        className="glass-panel dropdown-menu" 
                        style={{
                          position: 'absolute',
                          right: 0,
                          top: 'calc(100% + 6px)',
                          display: 'flex',
                          flexDirection: 'column',
                          width: '200px',
                          borderRadius: '8px',
                          boxShadow: 'var(--shadow-lg)',
                          zIndex: 30,
                          padding: '6px'
                        }}
                      >
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '4px 8px', fontWeight: 600 }}>Active Chapter</div>
                        <button
                          onClick={() => {
                            handleExport('html', false)
                            setIsExportDropdownOpen(false)
                          }}
                          className="dropdown-item"
                          type="button"
                          style={{ paddingLeft: '12px' }}
                        >
                          HTML (.html)
                        </button>
                        <button
                          onClick={() => {
                            handleExport('markdown', false)
                            setIsExportDropdownOpen(false)
                          }}
                          className="dropdown-item"
                          type="button"
                          style={{ paddingLeft: '12px' }}
                        >
                          Markdown (.md)
                        </button>
                        <button
                          onClick={() => {
                            handleExport('txt', false)
                            setIsExportDropdownOpen(false)
                          }}
                          className="dropdown-item"
                          type="button"
                          style={{ paddingLeft: '12px' }}
                        >
                          Plain Text (.txt)
                        </button>

                        <div style={{ height: '1px', backgroundColor: 'var(--border-color)', margin: '4px 0' }} />

                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '4px 8px', fontWeight: 600 }}>All Chapters (Combined)</div>
                        <button
                          onClick={() => {
                            handleExport('html', true)
                            setIsExportDropdownOpen(false)
                          }}
                          className="dropdown-item"
                          type="button"
                          style={{ paddingLeft: '12px' }}
                        >
                          HTML (.html)
                        </button>
                        <button
                          onClick={() => {
                            handleExport('markdown', true)
                            setIsExportDropdownOpen(false)
                          }}
                          className="dropdown-item"
                          type="button"
                          style={{ paddingLeft: '12px' }}
                        >
                          Markdown (.md)
                        </button>
                        <button
                          onClick={() => {
                            handleExport('txt', true)
                            setIsExportDropdownOpen(false)
                          }}
                          className="dropdown-item"
                          type="button"
                          style={{ paddingLeft: '12px' }}
                        >
                          Plain Text (.txt)
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {hasPendingDiffs && (
                <div className="diff-review-banner">
                  <span className="diff-banner-text">Review proposed edits to this chapter:</span>
                  <div className="diff-banner-actions">
                    <button 
                      onClick={handleAcceptAllDiffs} 
                      className="diff-banner-btn accept"
                      type="button"
                    >
                      Accept All
                    </button>
                    <button 
                      onClick={handleRejectAllDiffs} 
                      className="diff-banner-btn reject"
                      type="button"
                    >
                      Reject All
                    </button>
                  </div>
                </div>
              )}

              <div className="canvas-editor-container">
                <Editor 
                  content={activeDoc.content} 
                  onChange={(html) => {
                    triggerUnsaved()
                    const updates: Partial<CanvasDocument> = { content: html }
                    
                    // Sync title if the document starts with an <h1> tag
                    const tempDiv = document.createElement('div')
                    tempDiv.innerHTML = html
                    const firstChild = tempDiv.firstElementChild
                    if (firstChild && firstChild.tagName.toUpperCase() === 'H1') {
                      const extractedTitle = firstChild.textContent?.trim()
                      if (extractedTitle && extractedTitle !== activeDoc.title) {
                        updates.title = extractedTitle
                      }
                    }
                    updateActiveDocument(updates)
                  }} 
                  onQuickAction={handleQuickAction}
                />
              </div>

              <footer className="canvas-footer">
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>Words: {countWords(activeDoc.content)}</span>
                  <span style={{ opacity: 0.3 }}>|</span>
                  <span>
                    Session Tokens: In: {sessionInputTokens.toLocaleString()} 
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
                      (Hit: {sessionCacheHitTokens.toLocaleString()} / Miss: {sessionCacheMissTokens.toLocaleString()})
                    </span> 
                    / Out: {sessionOutputTokens.toLocaleString()}
                  </span>
                  <span style={{ opacity: 0.3 }}>|</span>
                  <span>Storage: {storageSize}</span>
                </div>
                <div>Active Chapter: {activeDoc.title}</div>
              </footer>
            </div>

            {/* Version History Sidebar Drawer */}
            <aside className={`history-sidebar ${isHistoryOpen ? 'open' : 'collapsed'}`}>
              <div className="history-header">
                <h3>Version History</h3>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={() => createVersionSnapshot('Manual Snapshot')}
                    className="btn-icon"
                    title="Save manual snapshot"
                    type="button"
                  >
                    <Sparkles size={16} style={{ color: 'var(--accent)' }} />
                  </button>
                  <button
                    onClick={() => setIsHistoryOpen(false)}
                    className="btn-icon"
                    title="Close history"
                    type="button"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
              <div className="history-list">
                {versions.filter(v => v.documentId === activeDocumentId).length === 0 ? (
                  <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    No snapshots taken yet for this chapter.
                  </div>
                ) : (
                  versions
                    .filter(v => v.documentId === activeDocumentId)
                    .map((version) => (
                      <div key={version.id} className="history-item">
                        <span className="history-item-title">{version.title}</span>
                        <span className="history-item-time">
                          {new Date(version.timestamp).toLocaleString([], {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                          })}
                        </span>
                        <div className="history-item-actions">
                          <button
                            onClick={() => restoreVersion(version.id)}
                            className="history-item-btn restore"
                            type="button"
                          >
                            Restore
                          </button>
                          <button
                            onClick={() => deleteVersionSnapshot(version.id)}
                            className="history-item-btn delete"
                            type="button"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </aside>
          </section>
      </main>

      {/* Settings Modal Overlay */}
      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
        errorMsg={errorMsg}
        setErrorMsg={setErrorMsg}
      />
    </div>
  )
}

export default App
