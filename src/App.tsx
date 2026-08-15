import { useState, useRef, useEffect, lazy, Suspense, useCallback, useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import { ChatPanel } from './components/ChatPanel'
import { ChaptersSidebar } from './components/ChaptersSidebar'
import { AppHeader } from './components/AppHeader'
import { CanvasHeader } from './components/CanvasHeader'
import { CanvasFooter } from './components/CanvasFooter'
import { VersionHistorySidebar } from './components/VersionHistorySidebar'
import { useAppStore } from './store/useAppStore'
import type { CanvasDocument } from './store/useAppStore'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'

import { Editor } from './components/Editor'

// Lazy loaded heavy components to speed up initial mobile page shell load
const SettingsModal = lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })))
const AuthForm = lazy(() => import('./components/AuthForm').then(m => ({ default: m.AuthForm })))
const ImageGenerationModal = lazy(() => import('./components/ImageGenerationModal').then(m => ({ default: m.ImageGenerationModal })))

import { useDiffHandlers } from './hooks/useDiffHandlers'
import { useModelFetcher } from './hooks/useModelFetcher'
import { useTranslation } from './i18n'
import { htmlToPlainText } from './utils/convert'

// Stable no-op callbacks for the app-level model fetch (the Settings modal
// passes its own real error/loading setters). Must be module-scoped so their
// identity never changes between renders — otherwise useModelFetcher's effect
// deps change every render and refetch in a loop (429 rate-limit).
const noop = () => {}

function App() {
  const { t } = useTranslation()
  // Zustand store state
  const {
    theme,
    documents,
    activeDocumentId,
    isSidebarOpen,
    updateActiveDocument,
    updateDocument,
    toggleSidebar,
    activeEditor,
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
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [imageGenInitialPrompt, setImageGenInitialPrompt] = useState('')
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

  // Keep the live model lists (Gemini/Grok) populated app-wide so the top-bar
  // model dropdown matches Settings even before Settings is ever opened.
  useModelFetcher(true, noop, noop)

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

      // Do NOT pull-overwrite from the server while we have local changes that
      // haven't been flushed yet. The save is debounced (~3s), so right after a
      // generation the new content (including pending diffs) lives only in
      // memory. Reloading from the server here would clobber it — this is what
      // made AI diffs vanish when DevTools/window focus changed mid-debounce.
      if (state.serverSaveStatus === 'saving') return
      const activeDoc = state.documents.find(d => d.id === state.activeDocumentId)
      if (activeDoc?.content?.includes('data-diff-id')) return

      try {
        const res = await fetch('/api/books')
        if (res.ok) {
          const books = await res.json()
          
          const currentBook = (books as Array<{ id: string; updatedAt?: string }>).find(b => b.id === state.activeBookId)
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

  const documentPlainTextContext = useMemo(() => htmlToPlainText(activeDoc.content), [activeDoc.content])
  const hasPendingDiffs = activeDoc.content.includes('data-diff-id')

  // Handle theme changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Handle theme changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

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
  // Open image generation modal with optional selected text as initial prompt
  const handleOpenImageGen = useCallback((selectedText: string) => {
    setImageGenInitialPrompt(selectedText)
    setIsImageGenOpen(true)
  }, [])

  useEffect(() => {
    const handleOpenImageEvent = (e: Event) => {
      const customEvent = e as CustomEvent<string>
      handleOpenImageGen(customEvent.detail)
    }
    window.addEventListener('open-image-gen', handleOpenImageEvent)
    return () => window.removeEventListener('open-image-gen', handleOpenImageEvent)
  }, [handleOpenImageGen])

  // Memoized editor onChange — avoids re-creating this on every render which
  // would cause the Editor to re-render on each App state change (e.g. chat input typing).
  const handleEditorChangeFor = useCallback((id: string, html: string) => {
    triggerUnsaved()
    const updates: Partial<CanvasDocument> = { content: html }
    // Sync the title when the document starts with an <h1>.
    // Problem: this used to do `tempDiv.innerHTML = html` on EVERY editor
    //   update. Setting innerHTML materializes <img> elements, and an <img>
    //   starts loading/decoding as soon as its src is set — even detached
    //   from the document. On a large imported chapter (55MB HTML, 200
    //   base64 images ≈ 440MB of decoded surfaces) every keystroke and every
    //   delete re-decoded all of them; the surfaces live in shared memory,
    //   which is what drove Firefox on Android to multi-GB RSS, a 5s
    //   main-thread stall and an ANR kill (desktops and Chrome absorbed it).
    // Fix: match the leading heading with a bounded regex — no DOM, no image
    //   materialization, O(1) in document size.
    const headingMatch = /^\s*<h1[^>]*>([\s\S]{0,2000}?)<\/h1>/i.exec(html.slice(0, 4096))
    if (headingMatch) {
      const extractedTitle = htmlToPlainText(headingMatch[1]).trim()
      const currentTitle = useAppStore.getState().documents.find(
        d => d.id === id
      )?.title
      if (extractedTitle && extractedTitle !== currentTitle) {
        updates.title = extractedTitle
      }
    }
    updateDocument(id, updates)
  }, [triggerUnsaved, updateDocument])

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
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>{t.app.materializingCanvas}</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>{t.app.checkingStorage}</p>
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
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>{t.app.loadingAuth}</p>
        </div>
      }>
        <AuthForm />
      </Suspense>
    )
  }


  return (
    <div className={`app-container layout-${layoutMode}`}>
      {/* Top Application Bar */}
      <AppHeader layoutMode={layoutMode} onOpenSettings={() => setIsSettingsOpen(true)} />

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

        <ChatPanel
          chatWidth={chatWidth}
          layoutMode={layoutMode}
          isHistoryOpen={isHistoryOpen}
          forceSave={forceSave}
          setSaveStatus={setSaveStatus}
        />

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
              <CanvasHeader
                activeDoc={activeDoc}
                layoutMode={layoutMode}
                saveStatus={saveStatus}
                forceSave={forceSave}
                triggerUnsaved={triggerUnsaved}
                isHistoryOpen={isHistoryOpen}
                setIsHistoryOpen={setIsHistoryOpen}
                onOpenImageGen={handleOpenImageGen}
              />

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
                {documents.map(doc => {
                  const isActive = doc.id === activeDocumentId
                  if (!isActive) return null
                  
                  // Show loading skeleton if content not yet loaded from server
                  if (doc.contentLoaded === false && doc.content === '') {
                    return (
                      <div key={doc.id} style={{ 
                        display: 'flex', 
                        flexDirection: 'column',
                        justifyContent: 'center', 
                        alignItems: 'center',
                        height: '100%',
                        gap: '1rem',
                        color: 'var(--text-muted)' 
                      }}>
                        <div className="loading-spinner" style={{ width: 32, height: 32 }} />
                        <span>Loading chapter content...</span>
                      </div>
                    )
                  }

                  return (
                    <div 
                      key={doc.id} 
                      style={{ height: '100%', width: '100%' }}
                    >
                      <Editor 
                        isActive={true}
                        content={doc.content} 
                        onChange={(html) => handleEditorChangeFor(doc.id, html)}
                      />
                    </div>
                  )
                })}
              </div>


              <CanvasFooter activeDoc={activeDoc} />
            </div>

            {/* Version History Sidebar Drawer */}
            <VersionHistorySidebar isHistoryOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} />
          </section>
      </main>

      {/* Settings Modal Overlay */}
      <Suspense fallback={null}>
        <SettingsModal 
          isOpen={isSettingsOpen} 
          onClose={() => setIsSettingsOpen(false)} 
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
