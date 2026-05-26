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
  Paperclip
} from 'lucide-react'
import { Editor } from './components/Editor'
import { SettingsModal } from './components/SettingsModal'
import { ChaptersSidebar } from './components/ChaptersSidebar'
import { useAppStore } from './store/useAppStore'
import { streamLLM } from './services/llm'
import type { LLMMessage } from './services/llm'

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
    setStreaming
  } = useAppStore()

  // Local UI state
  const [chatInput, setChatInput] = useState('')
  const [chatWidth, setChatWidth] = useState(380)
  const [isResizing, setIsResizing] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isLoadingModels, setIsLoadingModels] = useState(false)

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
            } else {
              setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
            }
          } else {
            setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
          }
        } else {
          setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
        }
      } catch (err) {
        console.error('Failed to fetch official Gemini models, using fallbacks', err)
        setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
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
  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!chatInput.trim() || isStreaming) return

    setErrorMsg(null)
    const promptText = chatInput.trim()
    setChatInput('')

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

    const customPromptText = geminiConfig.systemPrompt || ''

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
   Example:
   <canvas>
   <h1>Title</h1>
   <p>This is the updated document content.</p>
   </canvas>
2. Write conversational feedback/explanations OUTSIDE the "<canvas>" tags for the chat panel.
3. Make sure to return the FULL updated document inside "<canvas>", not just parts of it. Do not truncate the document.
4. Output the document as clean HTML inside the "<canvas>" block (using tags like h1, h2, p, ul, ol, li, strong, em, blockquote, pre, code).
5. If the user instruction is just conversational and does not require updating the document, DO NOT output any "<canvas>" block. Just write a conversational reply.

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
        { ...geminiConfig, provider: 'gemini' },
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

            // Update document if canvas text was extracted
            if (canvasText.trim()) {
              updateActiveDocument({ content: canvasText })
            }
          },
          onDone: (fullText: string) => {
            setStreaming(false)
            // Clear reference attachments selection on submit completion
            clearReferences()

            const canvasStart = '<canvas>'
            const canvasEnd = '</canvas>'
            const startIdx = fullText.indexOf(canvasStart)
            let finalChatText = ''

            if (startIdx !== -1) {
              finalChatText = fullText.substring(0, startIdx).trim()
              const rest = fullText.substring(startIdx + canvasStart.length)
              const endIdx = rest.indexOf(canvasEnd)
              if (endIdx !== -1) {
                finalChatText += '\n\n' + rest.substring(endIdx + canvasEnd.length).trim()
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
          }
        }
      )
    } catch (e: any) {
      setStreaming(false)
      setErrorMsg(e.message || 'Failed to initialize LLM stream.')
    }
  }

  // Clear chat handler
  const handleClearChat = () => {
    clearChat()
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
              gap: '0.5rem'
            }}>
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{errorMsg}</span>
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

          <div className="canvas-editor-container">
            <Editor 
              content={activeDoc.content} 
              onChange={(html) => updateActiveDocument({ content: html })} 
            />
          </div>

          <footer className="canvas-footer">
            <div>Words: {activeDoc.content.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length}</div>
            <div>Active Chapter: {activeDoc.title}</div>
          </footer>
        </section>
      </main>

      {/* Settings Modal Overlay */}
      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
      />
    </div>
  )
}

export default App
