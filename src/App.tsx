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
  X
} from 'lucide-react'
import { Editor } from './components/Editor'
import { SettingsModal } from './components/SettingsModal'
import { ChaptersSidebar } from './components/ChaptersSidebar'
import { useAppStore } from './store/useAppStore'
import { streamLLM } from './services/llm'
import type { LLMMessage } from './services/llm'
import { diffHtml } from './utils/diff'

// Fallback standard Gemini models
const FALLBACK_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b'
]

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
    clearReferences,
    toggleSidebar,
    providerConfigs,
    updateProviderConfig,
    availableGeminiModels,
    setAvailableGeminiModels,
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
    resetSessionTokens
  } = useAppStore()

  // Local UI state
  const [chatInput, setChatInput] = useState('')
  const [chatWidth, setChatWidth] = useState(380)
  const [isResizing, setIsResizing] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [storageSize, setStorageSize] = useState('0.00 KB')

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

  // Update storage usage when documents, theme or LLM configurations change
  useEffect(() => {
    updateStorageSize()
  }, [documents, theme, providerConfigs])

  const chatEndRef = useRef<HTMLDivElement>(null)
  const isResizingRef = useRef(false)
  const accumulatedTextRef = useRef('')

  // Retrieve active document
  const activeDoc = documents.find(d => d.id === activeDocumentId) || documents[0] || {
    id: 'default',
    title: 'Untitled Chapter',
    content: '<p>Start writing...</p>'
  }

  const geminiConfig = providerConfigs.gemini
  const apiKey = geminiConfig.apiKey
  const baseUrl = geminiConfig.baseUrl

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
      if (!apiKey || apiKey === 'ollama-no-key') {
        setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
        return
      }

      setIsLoadingModels(true)
      try {
        let url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        if (baseUrl && baseUrl !== 'https://generativelanguage.googleapis.com/v1beta') {
          url = `${baseUrl.replace(/\/$/, '')}/models?key=${apiKey}`
        }

        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          if (data.models && Array.isArray(data.models)) {
            const filtered = data.models
              .filter((m: any) => 
                (m.supportedGenerationMethods?.includes('generateContent') || 
                 m.supportedGenerationMethods?.includes('streamGenerateContent')) &&
                !m.name.includes('embedding') &&
                !m.name.includes('aqa')
              )
              .map((m: any) => {
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
      } catch (err: any) {
        console.error('Failed to fetch official Gemini models, using fallbacks', err)
        setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
        setErrorMsg(`Failed to connect to Gemini API: ${err.message || err}. Using fallback models.`)
      } finally {
        setIsLoadingModels(false)
      }
    }

    fetchOfficialModels()
  }, [apiKey, baseUrl, setAvailableGeminiModels, updateProviderConfig, geminiConfig.model])

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

  // Send message handler (streaming and parsing)
  const handleSendMessage = async (e?: React.FormEvent, customPrompt?: string) => {
    e?.preventDefault()
    
    const promptText = customPrompt ? customPrompt.trim() : chatInput.trim()
    if (!promptText || isStreaming) return

    setErrorMsg(null)
    const originalDocContent = activeDoc.content
    
    if (!customPrompt) {
      setChatInput('')
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
    const userMsgId = `user-${Date.now()}`
    const userMsg = {
      id: userMsgId,
      role: 'user' as const,
      content: promptText,
      timestamp: new Date().toISOString()
    }
    addMessage(userMsg)

    // 3. Add assistant placeholder
    const assistantMsgId = `assistant-${Date.now()}`
    const assistantPlaceholder = {
      id: assistantMsgId,
      role: 'assistant' as const,
      content: 'Thinking...',
      timestamp: new Date().toISOString()
    }
    addMessage(assistantPlaceholder)
    setStreaming(true)

    accumulatedTextRef.current = ''

    // 4. Build referenced document contents context
    let referenceDocsContext = ''
    finalReferenceIds.forEach(refId => {
      const refDoc = documents.find(d => d.id === refId)
      if (refDoc) {
        referenceDocsContext += `\nREFERENCE DOCUMENT "${refDoc.title}" (READ-ONLY):\n"""\n${refDoc.content}\n"""\n`
      }
    })

    // Build overall project outline context
    const outlineList = documents
      .map(d => `- ${d.title}${d.id === activeDocumentId ? ' (Active / Editing Target)' : ''}`)
      .join('\n')

    const activePromptItem = customSystemPrompts.find(p => p.id === activeSystemPromptId) || customSystemPrompts[0]
    const customPromptText = activePromptItem?.content || ''

    // Construct selection context block
    const selectionContext = selectedText
      ? `\nCURRENT SELECTED TEXT IN ACTIVE DOCUMENT (Focus your edits ONLY on this section if the user instructs so):\n"""\n${selectedText}\n"""\n`
      : ''

    // Create system instruction prompt
    const systemPrompt: LLMMessage = {
      role: 'system',
      content: `You are an expert document writing and editing assistant.
You help the user write, edit, and polish the ACTIVE document shown on their screen.

${customPromptText ? `USER CUSTOM SYSTEM PROMPT / INSTRUCTIONAL GUIDELINES:\n${customPromptText}\n\n` : ''}CHAPTER OUTLINE (OVERVIEW OF ALL WRITTEN CHAPTERS):
${outlineList}
${referenceDocsContext ? `\nREFERENCED DOCUMENT CONTEXTS (Read-only, do not modify these but use them for details/consistency):\n${referenceDocsContext}` : ''}

CRITICAL RULES:
1. If your response updates the ACTIVE document, wrap the updated document text in a "<canvas>" XML block.
   Make sure to return the FULL updated document inside "<canvas>", not just the selection or parts of it. Do not truncate the document.
2. Write conversational feedback/explanations OUTSIDE the "<canvas>" tags for the chat panel.
3. Output the document as clean HTML inside the "<canvas>" block (using tags like h1, h2, p, ul, ol, li, strong, em, blockquote, pre, code).
4. If the user instruction is just conversational and does not require updating the document, DO NOT output any "<canvas>" block. Just write a conversational reply.

${selectionContext}
CURRENT ACTIVE DOCUMENT CONTENT (This is the ONLY document you can update):
"""
${activeDoc.content}
"""`
    }

    // Map chat history to LLM provider structure
    const historyMessages: LLMMessage[] = messages
      .filter(m => m.id !== 'welcome') // skip initial welcome for cleaner context
      .map(m => ({
        role: m.role,
        content: m.content
      }))

    // Add current user prompt
    historyMessages.push({
      role: 'user',
      content: promptText
    })

    const apiMessages = [systemPrompt, ...historyMessages]
    const estimatedInputTokens = Math.ceil(JSON.stringify(apiMessages).length / 4)

    // Construct visual attachment text indicators
    const attachmentsText = finalReferenceIds
      .map(id => {
        const doc = documents.find(d => d.id === id)
        return doc ? `[Attached Context: ${doc.title}]` : ''
      })
      .filter(Boolean)
      .join('\n')

    try {
      await streamLLM(
        apiMessages,
        { ...geminiConfig, provider: 'gemini', debug: debugMode },
        {
          onChunk: (chunk: string) => {
            accumulatedTextRef.current += chunk
            const raw = accumulatedTextRef.current

            // Canvas Markup Protocol Parser
            let chatText = ''
            let canvasText = ''
            const canvasStart = '<canvas>'
            const canvasEnd = '</canvas>'

            const startIdx = raw.indexOf(canvasStart)
            if (startIdx !== -1) {
              chatText = raw.substring(0, startIdx).trim()
              const rest = raw.substring(startIdx + canvasStart.length)
              
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

            // Update document in real-time with raw text stream
            if (canvasText.trim()) {
              updateActiveDocument({ content: canvasText })
            }
          },
          onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }) => {
            setStreaming(false)
            // Clear reference attachments selection on submit completion
            clearReferences()

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

            const canvasStart = '<canvas>'
            const canvasEnd = '</canvas>'
            const startIdx = fullText.indexOf(canvasStart)
            let finalChatText = ''
            let finalCanvasText = ''

            if (startIdx !== -1) {
              finalChatText = fullText.substring(0, startIdx).trim()
              const rest = fullText.substring(startIdx + canvasStart.length)
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
            if (finalCanvasText.trim()) {
              const diffed = diffHtml(originalDocContent, finalCanvasText)
              updateActiveDocument({ content: diffed })
            }
          },
          onError: (err: Error) => {
            setStreaming(false)
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
          }
        }
      )
    } catch (e: any) {
      setStreaming(false)
      setErrorMsg(e.message || 'Failed to initialize LLM stream.')
    }
  }

  const hasPendingDiffs = activeDoc.content.includes('data-diff-id')

  // Accept all additions and finalize all deletions in active document
  const handleAcceptAllDiffs = () => {
    if (activeEditor) {
      const { state, view } = activeEditor
      const { doc } = state
      const tr = state.tr
      const changes: { from: number; to: number; type: 'addition' | 'deletion' }[] = []

      doc.descendants((node, pos) => {
        if (node.isText) {
          node.marks.forEach(mark => {
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
  }

  // Reject all additions and restore all deleted text in active document
  const handleRejectAllDiffs = () => {
    if (activeEditor) {
      const { state, view } = activeEditor
      const { doc } = state
      const tr = state.tr
      const changes: { from: number; to: number; type: 'addition' | 'deletion' }[] = []

      doc.descendants((node, pos) => {
        if (node.isText) {
          node.marks.forEach(mark => {
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

  // Download document as HTML
  const handleDownloadDoc = () => {
    const element = document.createElement("a")
    const styledHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${activeDoc.title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #1e293b; max-width: 740px; margin: 2rem auto; padding: 0 1rem; }
    h1, h2, h3 { color: #0f172a; }
    blockquote { border-left: 4px solid #f59e0b; padding-left: 1rem; font-style: italic; color: #475569; }
    pre { background-color: #f1f5f9; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    code { font-family: monospace; background-color: #f1f5f9; padding: 0.2rem 0.4rem; border-radius: 4px; }
  </style>
</head>
<body>
  ${activeDoc.content}
</body>
</html>`
    const file = new Blob([styledHtml], {type: 'text/html'})
    element.href = URL.createObjectURL(file)
    element.download = `${activeDoc.title.toLowerCase().replace(/\s+/g, '-')}.html`
    document.body.appendChild(element)
    element.click()
    document.body.removeChild(element)
  }

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    updateProviderConfig('gemini', { model: e.target.value })
  }

  return (
    <div className="app-container">
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
          {/* Dynamic Gemini Model Selector Dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Model:</span>
            <select 
              className="select-styled" 
              value={geminiConfig.model} 
              onChange={handleModelChange}
              title="Select Gemini Model"
              disabled={isLoadingModels}
            >
              {availableGeminiModels.map(model => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            {isLoadingModels && (
              <RefreshCw size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
            )}
          </div>

          {/* System Prompt Selector Dropdown */}
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

          {/* Settings Button */}
          <button 
            onClick={() => setIsSettingsOpen(true)} 
            className="btn-icon" 
            title="Open Gemini Settings"
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
        </div>
      </header>

      {/* Main split work area */}
      <main className="app-main">
        {/* Chapters Left Sidebar */}
        <ChaptersSidebar />

        {/* Resizable Chat Panel */}
        <section 
          className="chat-panel" 
          style={{ width: `${chatWidth}px` }}
        >
          <div className="chat-header">
            <h2>Assistant Chat (Gemini)</h2>
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
                <div className="chat-message-bubble">
                  {msg.content}
                </div>
                <span className="chat-message-info">
                  {msg.role === 'user' ? 'You' : 'Gemini'} • {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
            {isStreaming && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                <RefreshCw size={12} className="animate-spin" />
                <span>Gemini is streaming changes...</span>
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
            <div className="chat-input-wrapper">
              <textarea
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendMessage()
                  }
                }}
                placeholder={`Instruct Gemini (${geminiConfig.model})...`}
                className="chat-textarea"
                rows={1}
                disabled={isStreaming}
              />
              <button 
                type="submit" 
                className="btn-icon" 
                title="Send instruction"
                disabled={!chatInput.trim() || isStreaming}
                style={{ 
                  color: chatInput.trim() && !isStreaming ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: chatInput.trim() && !isStreaming ? 'pointer' : 'default'
                }}
              >
                <Send size={18} />
              </button>
            </div>
          </form>
        </section>

        {/* Resizing Divider Gutter */}
        <div 
          className={`resize-handle ${isResizing ? 'active' : ''}`}
          onMouseDown={startResizing}
        />

        {/* Right Side: Document Canvas Panel */}
        <section className="canvas-panel">
          <div className="canvas-header">
            <div className="canvas-title-wrapper">
              <BookOpen size={16} style={{ color: 'var(--text-secondary)' }} />
              <input
                type="text"
                value={activeDoc.title}
                onChange={e => updateActiveDocument({ title: e.target.value })}
                className="canvas-title-input"
                placeholder="Untitled Document"
                title="Document Title"
              />
            </div>
            
            <div className="canvas-actions">
              <button className="btn-icon" title="View snapshots history" type="button">
                <History size={18} />
              </button>
              <button 
                onClick={handleDownloadDoc} 
                className="btn-icon" 
                title="Download HTML"
                type="button"
              >
                <Download size={18} />
              </button>
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
              onChange={(html) => updateActiveDocument({ content: html })} 
              onQuickAction={handleQuickAction}
            />
          </div>

          <footer className="canvas-footer">
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <span>Words: {activeDoc.content.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length}</span>
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
