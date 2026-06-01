import { useState, useRef, useEffect, lazy, Suspense, useCallback, useMemo } from 'react'
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
  Clipboard,
  Wand2
} from 'lucide-react'
import { ChaptersSidebar } from './components/ChaptersSidebar'
import { useAppStore, PROVIDER_MODELS } from './store/useAppStore'
import type { CanvasDocument, LLMProvider } from './store/useAppStore'
import { countWords, convertBlobUrlToDataUrl, convertGifToJpegIfNeeded } from './utils/text'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'

import { Editor } from './components/Editor'

// Lazy loaded heavy components to speed up initial mobile page shell load
const SettingsModal = lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })))
const AuthForm = lazy(() => import('./components/AuthForm').then(m => ({ default: m.AuthForm })))
const ImageGenerationModal = lazy(() => import('./components/ImageGenerationModal').then(m => ({ default: m.ImageGenerationModal })))

import { useImageUpload } from './hooks/useImageUpload'
import { useModelFetcher } from './hooks/useModelFetcher'
import { useDiffHandlers } from './hooks/useDiffHandlers'
import { useChatLLM } from './hooks/useChatLLM'
import { useTranslation } from './i18n'

function App() {
  const { t } = useTranslation()
  // Zustand store state
  const {
    theme,
    setTheme,
    language,
    setLanguage,
    documents,
    activeDocumentId,
    isSidebarOpen,
    selectedReferenceIds,
    updateActiveDocument,
    toggleReference,
    toggleSidebar,
    activeProvider,
    providerConfigs,
    updateProviderConfig,
    availableGeminiModels,
    availableGrokModels,
    messages,
    clearChat,
    isStreaming,
    customSystemPrompts,
    activeSystemPromptId,
    selectedText,
    activeEditor,
    resetSessionTokens,
    versions,
    bookTitle,
    isStoreInitialized,
    user,
    activeBookId,
    switchBook,
    lastSyncedAt
  } = useAppStore()

  // Local UI state
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

  // Save status state
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved'>('saved')
  const saveTimeoutRef = useRef<number | null>(null)

  const triggerUnsaved = useCallback(() => {
    setSaveStatus('unsaved')
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = window.setTimeout(() => {
      setSaveStatus('saved')
    }, 1500)
  }, [])

  const forceSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    setSaveStatus('saved')
  }, [])

  // Multimodal image upload states & logic
  const {
    uploadedImages,
    setUploadedImages,
  } = useImageUpload()

  const {
    chatInput,
    setChatInput,
    chatInputRef,
    chatEndRef,
    setErrorMsg,
    handleSendMessage,
    handleStopGeneration
  } = useChatLLM({
    activeEditor,
    selectedText,
    uploadedImages,
    setUploadedImages,
    layoutMode,
    setIsChatExpanded,
    forceSave,
    setSaveStatus
  })

  useModelFetcher(isSettingsOpen, setErrorMsg, () => {})

  // Image generation modal state
  const [isImageGenOpen, setIsImageGenOpen] = useState(false)

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [])

  // Background prefetch heavy chunks as soon as the main shell is interactive
  useEffect(() => {
    const prefetch = () => {
      import('./components/SettingsModal').catch(err => console.warn('Failed to prefetch SettingsModal', err))
      import('./components/AuthForm').catch(err => console.warn('Failed to prefetch AuthForm', err))
      import('./components/ImageGenerationModal').catch(err => console.warn('Failed to prefetch ImageGenerationModal', err))
    }
    
    if (document.readyState === 'complete') {
      prefetch()
    } else {
      window.addEventListener('load', prefetch)
      return () => window.removeEventListener('load', prefetch)
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

  // Track window size for mobile responsive layouts
  useEffect(() => {
    const handleResize = () => {
      setLayoutMode(getLayoutMode(window.innerWidth, window.innerHeight))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // 2. Cross-Device Sync: Fetch server books and check for modifications on tab focus/visibility change
  useEffect(() => {
    const checkServerUpdates = async () => {
      const state = useAppStore.getState()
      if (!state.user || state.isStreaming) return

      try {
        const res = await fetch('/api/books')
        if (res.ok) {
          const books = await res.json()
          
          const currentBook = books.find((b: any) => b.id === state.activeBookId)
          if (currentBook) {
            const serverUpdatedAt = currentBook.updatedAt
            const localLastSyncedAt = state.lastSyncedAt

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

  const isResizingRef = useRef(false)

  // Retrieve active document
  const activeDoc = documents.find(d => d.id === activeDocumentId) || documents[0] || {
    id: 'default',
    title: 'Untitled Chapter',
    content: '<p>Start writing...</p>'
  }

  const activeConfig = providerConfigs[activeProvider]

  // Handle theme changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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

  const { handleAcceptAllDiffs, handleRejectAllDiffs } = useDiffHandlers(
    activeEditor,
    activeDoc,
    updateActiveDocument,
    triggerUnsaved
  )

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

  // Open image generation modal with optional selected text as initial prompt
  const handleOpenImageGen = useCallback((selectedText: string) => {
    setImageGenInitialPrompt(selectedText)
    setIsImageGenOpen(true)
  }, [])

  // Memoized editor onChange — avoids re-creating this on every render which
  // would cause the Editor to re-render on each App state change (e.g. chat input typing).
  const handleEditorChange = useCallback((html: string) => {
    triggerUnsaved()
    const updates: Partial<CanvasDocument> = { content: html }
    // Sync title if the document starts with an <h1> tag
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = html
    const firstChild = tempDiv.firstElementChild
    if (firstChild && firstChild.tagName.toUpperCase() === 'H1') {
      const extractedTitle = firstChild.textContent?.trim()
      const currentTitle = useAppStore.getState().documents.find(
        d => d.id === useAppStore.getState().activeDocumentId
      )?.title
      if (extractedTitle && extractedTitle !== currentTitle) {
        updates.title = extractedTitle
      }
    }
    useAppStore.getState().updateActiveDocument(updates)
  }, [triggerUnsaved])

  // Insert a generated image (base64 data URL) into the active editor at cursor position
  const handleInsertGeneratedImage = useCallback((dataUrl: string, altText: string) => {
    if (!activeEditor) return
    const imgHtml = `<img src="${dataUrl}" alt="${altText.replace(/"/g, '&quot;')}" style="max-width: 100%; height: auto; border-radius: 6px;" />`
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = imgHtml
    const slice = ProseMirrorDOMParser.fromSchema(activeEditor.state.schema).parseSlice(tempDiv)
    const tr = activeEditor.state.tr
    const { to } = activeEditor.state.selection
    tr.insert(to, slice.content)
    activeEditor.view.dispatch(tr)
    // Use getState() to avoid listing updateActiveDocument as a dependency (it's a new ref each render)
    useAppStore.getState().updateActiveDocument({ content: activeEditor.getHTML() })
    triggerUnsaved()
  }, [activeEditor, triggerUnsaved])

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
    exportDocument(format, exportAll, documents, activeDoc, bookTitle)
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
    return (
      <Suspense fallback={
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
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>Loading authentication workspace...</p>
        </div>
      }>
        <AuthForm />
      </Suspense>
    )
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
              title={t.app.sidebarToggle}
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
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.app.activeModel}</span>
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
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.app.systemPrompt}</span>
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
            title={t.app.settingsTitle}
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

          {/* Language Switcher */}
          <button 
            onClick={() => setLanguage(language === 'en' ? 'zh' : 'en')} 
            className="btn-icon font-medium text-xs" 
            title={language === 'en' ? 'Switch to Chinese' : 'Switch to English'}
            type="button"
            style={{ width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {language === 'en' ? '中' : 'EN'}
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
                <h2>{t.app.chatTitle} ({getProviderLabel(activeProvider)})</h2>
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
                          {t.app.dismiss}
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
                  title={t.app.dismiss}
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
                            let dataUrl = src
                            if (src.startsWith('blob:')) {
                              try {
                                dataUrl = await convertBlobUrlToDataUrl(src)
                              } catch (err) {
                                console.error('Failed to convert blob URL:', err)
                              }
                            }
                            try {
                              const processedDataUrl = await convertGifToJpegIfNeeded(dataUrl)
                              newImages.push(processedDataUrl)
                            } catch (err) {
                              console.error('Failed to process pasted/dropped GIF image:', err)
                              newImages.push(dataUrl)
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
                      handleStopGeneration()
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
                    title={t.app.historyToggle} 
                    type="button"
                    style={{ color: isHistoryOpen ? 'var(--accent)' : 'inherit' }}
                  >
                    <History size={18} />
                  </button>
                  
                  {/* Generate Image Button */}
                  <button
                    onClick={() => handleOpenImageGen(selectedText || '')}
                    className="btn-icon"
                    title="Generate image with AI (uses selected text as prompt)"
                    type="button"
                    style={{
                      background: 'linear-gradient(135deg, var(--accent), #a78bfa)',
                      color: 'white',
                      borderRadius: '7px',
                      padding: '5px 10px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      border: 'none',
                      boxShadow: '0 2px 8px rgba(124, 58, 237, 0.3)',
                    }}
                  >
                    <Wand2 size={14} />
                    {layoutMode !== 'portrait' && 'Gen Image'}
                  </button>

                  {/* Export Dropdown relative wrapper */}
                  <div style={{ position: 'relative', display: 'inline-block' }}>
                    <button 
                      onClick={() => setIsExportDropdownOpen(!isExportDropdownOpen)} 
                      className={`btn-icon ${isExportDropdownOpen ? 'active' : ''}`} 
                      title={t.app.exportDoc}
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
                  <span className="diff-banner-text">{t.app.diffReview.title}</span>
                  <div className="diff-banner-actions">
                    <button 
                      onClick={handleAcceptAllDiffs} 
                      className="diff-banner-btn accept"
                      type="button"
                    >
                      {t.app.diffReview.acceptAll}
                    </button>
                    <button 
                      onClick={handleRejectAllDiffs} 
                      className="diff-banner-btn reject"
                      type="button"
                    >
                      {t.app.diffReview.rejectAll}
                    </button>
                  </div>
                </div>
              )}

              <div className="canvas-editor-container">
                <Editor 
                  content={activeDoc.content} 
                  onChange={handleEditorChange}
                  onQuickAction={handleQuickAction}
                  onGenerateImage={handleOpenImageGen}
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
      <Suspense fallback={null}>
        <SettingsModal 
          isOpen={isSettingsOpen} 
          onClose={() => setIsSettingsOpen(false)} 
          errorMsg={errorMsg}
          setErrorMsg={setErrorMsg}
        />
      </Suspense>

      {/* Image Generation Modal */}
      <Suspense fallback={null}>
        <ImageGenerationModal
          isOpen={isImageGenOpen}
          onClose={() => setIsImageGenOpen(false)}
          initialPrompt={imageGenInitialPrompt}
          documentContext={documentPlainTextContext}
          onInsertImage={handleInsertGeneratedImage}
        />
      </Suspense>
    </div>
  )
}

export default App
