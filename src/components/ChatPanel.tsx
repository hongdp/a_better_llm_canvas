import React, { useState, useEffect, useCallback } from 'react'
import { 
  Send, Trash2, AlertCircle, Paperclip, X, SquarePen, ChevronDown, ChevronUp, Image, Square, Clipboard, RefreshCw, Swords
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { convertBlobUrlToDataUrl, convertGifToJpegIfNeeded } from '../utils/text'
import { selectReferenceChapters, type SelectionResult } from '../utils/contextSelection'
import { useImageUpload } from '../hooks/useImageUpload'
import { useChatLLM } from '../hooks/useChatLLM'
import { useRoleplayLLM } from '../hooks/useRoleplayLLM'
import { useTranslation } from '../i18n'
import { RoleplayBanner } from './RoleplayBanner'
import { RoleplaySetupModal } from './RoleplaySetupModal'

interface ChatPanelProps {
  chatWidth: number
  layoutMode: 'desktop' | 'portrait' | 'landscape' | 'tablet-square'
  isHistoryOpen: boolean
  forceSave: () => void
  setSaveStatus: (status: 'saved' | 'unsaved') => void
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  chatWidth,
  layoutMode,
  isHistoryOpen,
  forceSave,
  setSaveStatus
}) => {
  const { t } = useTranslation()
  const {
    documents,
    activeDocumentId,
    pinnedReferenceIds,
    blockedReferenceIds,
    cycleReferenceState,
    wholeBookMode,
    setWholeBookMode,
    activeProvider,
    providerConfigs,
    messages,
    clearChat,
    resetSessionTokens,
    isStreaming,
    selectedText,
    activeEditor,
    roleplayMode,
    roleplayConfig,
    setRoleplayMode,
    setRoleplayConfig
  } = useAppStore()

  const [isChatExpanded, setIsChatExpanded] = useState(false)
  const [isRpSetupOpen, setIsRpSetupOpen] = useState(false)
  const activeConfig = providerConfigs[activeProvider]

  const {
    uploadedImages,
    setUploadedImages,
    fileInputRef,
    handleImageUpload,
    handlePaste,
    handlePasteFromClipboard
  } = useImageUpload()

  const chatLLM = useChatLLM({
    activeEditor,
    selectedText,
    uploadedImages,
    setUploadedImages,
    layoutMode,
    setIsChatExpanded,
    forceSave,
    setSaveStatus
  })

  const rpLLM = useRoleplayLLM({
    uploadedImages,
    setUploadedImages: (imgs: string[]) => setUploadedImages(imgs),
    layoutMode,
    setIsChatExpanded,
  })

  // Route to the right hook based on mode
  const chatInput = roleplayMode ? rpLLM.rpChatInput : chatLLM.chatInput
  const setChatInput = roleplayMode ? rpLLM.setRpChatInput : chatLLM.setChatInput
  const chatInputRef = roleplayMode ? rpLLM.rpChatInputRef : chatLLM.chatInputRef
  const chatEndRef = roleplayMode ? rpLLM.rpChatEndRef : chatLLM.chatEndRef
  const errorMsg = roleplayMode ? rpLLM.rpErrorMsg : chatLLM.errorMsg
  const setErrorMsg = roleplayMode ? rpLLM.setRpErrorMsg : chatLLM.setErrorMsg
  const handleSendMessage = roleplayMode ? rpLLM.handleRpSendMessage : chatLLM.handleSendMessage
  const handleStopGeneration = roleplayMode ? rpLLM.handleRpStopGeneration : chatLLM.handleStopGeneration
  const { editingMessageId, setEditingMessageId, editingMessageText, setEditingMessageText, handleResubmitMessage } = chatLLM

  // Live preview of the Layer 1 auto-selection: recomputed (debounced) as the
  // user types so the tag bar shows what will be attached BEFORE sending.
  // The preview omits the previous-turn continuity signal (it lives inside
  // useChatLLM); the difference is at most one low-score tag.
  const [selectionPreview, setSelectionPreview] = useState<SelectionResult | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      setSelectionPreview(documents.length < 2 ? null : selectReferenceChapters({
        promptText: chatInput,
        recentHistory: messages.filter(m => m.id !== 'welcome').map(m => m.content),
        documents,
        activeDocumentId,
        pinnedIds: pinnedReferenceIds,
        blockedIds: blockedReferenceIds
      }))
    }, 300)
    return () => clearTimeout(timer)
  }, [chatInput, documents, activeDocumentId, pinnedReferenceIds, blockedReferenceIds, messages])

  // Handle starting a new RP game
  const handleStartRpGame = useCallback(async (config: { characterName: string; genre: string; difficulty: 'easy' | 'normal' | 'hard'; customWorldDesc?: string }) => {
    setIsRpSetupOpen(false)
    await rpLLM.handleInitializeGame(config)
  }, [rpLLM])

  // Handle ending the RP game
  const handleEndRpGame = useCallback(() => {
    if (window.confirm('End the current roleplay session? Your game documents will be preserved.')) {
      setRoleplayMode(false)
      setRoleplayConfig(null)
    }
  }, [setRoleplayMode, setRoleplayConfig])

  const getProviderLabel = (prov: string) => {
    return prov === 'grok' ? 'Grok' : prov.charAt(0).toUpperCase() + prov.slice(1)
  }

  const getResponderName = (msg: typeof messages[0]) => {
    if (msg.role === 'user') return 'You' // Or use translation if preferred
    const prov = msg.provider || activeProvider
    const model = msg.model || activeConfig.model
    return `${getProviderLabel(prov)} (${model})`
  }

  const handleClearChat = () => {
    clearChat()
    resetSessionTokens()
  }

  // Listen for quick actions from the editor
  useEffect(() => {
    const handleQuickAction = (e: Event) => {
      const customEvent = e as CustomEvent<string>
      handleSendMessage(undefined, customEvent.detail)
    }
    window.addEventListener('send-quick-action', handleQuickAction)
    return () => window.removeEventListener('send-quick-action', handleQuickAction)
  }, [handleSendMessage])

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])


  return (
    <>
    <section 
      className={`chat-panel ${isChatExpanded ? 'expanded' : ''} ${isHistoryOpen ? 'open' : ''} ${roleplayMode ? 'rp-active' : ''}`} 
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
              title={t.app.collapseChat}
              type="button"
            >
              <ChevronDown size={18} />
            </button>
          )}
          <h2>{roleplayMode ? '⚔️ Roleplay' : t.app.chatTitle} ({getProviderLabel(activeProvider)})</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {/* Roleplay Toggle Button */}
          <button
            onClick={() => {
              if (roleplayMode) {
                handleEndRpGame()
              } else {
                setIsRpSetupOpen(true)
              }
            }}
            className={`rp-toggle-btn ${roleplayMode ? 'active' : ''}`}
            title={roleplayMode ? 'End roleplay session' : 'Start a roleplay game'}
            type="button"
            disabled={isStreaming}
          >
            <Swords size={13} />
            {roleplayMode ? 'RP On' : 'RP'}
          </button>
          <button 
            onClick={handleClearChat} 
            className="btn-icon" 
            title={t.app.clearChat}
            type="button"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {/* Roleplay Banner — shows game stats when RP is active */}
      {roleplayMode && roleplayConfig && (
        <RoleplayBanner onEndGame={handleEndRpGame} />
      )}

      <div className="chat-messages">
        {messages.map(msg => {
          // Determine RP-specific CSS classes
          const rpClass = msg.rpType === 'narration' ? 'rp-narration'
            : msg.rpType === 'action' ? 'rp-action'
            : msg.rpType === 'system_event' ? 'rp-system-event'
            : ''

          return (
            <div key={msg.id} className={`chat-message ${msg.role} ${rpClass}`}>
              {editingMessageId === msg.id && !roleplayMode ? (
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
                      {t.app.saveAndSubmit}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="chat-message-bubble">
                    {/* RP Action Prefix for user messages */}
                    {msg.rpType === 'action' && roleplayConfig && (
                      <div className="rp-action-prefix">
                        <Swords size={11} />
                        {roleplayConfig.characterName}
                      </div>
                    )}
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

                    {/* RP Choices — clickable action buttons */}
                    {msg.rpChoices && msg.rpChoices.length > 0 && !isStreaming && (
                      <div className="rp-choices-container">
                        <div className="rp-choices-label">Choose your path:</div>
                        {msg.rpChoices.map((choice, idx) => (
                          <button
                            key={idx}
                            className="rp-choice-btn"
                            type="button"
                            onClick={() => handleSendMessage(undefined, choice)}
                            disabled={isStreaming}
                          >
                            <span className="rp-choice-number">{idx + 1}</span>
                            {choice}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {msg.rpType !== 'system_event' && (
                    <span className="chat-message-info" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <span>
                        {msg.rpType === 'narration' ? '🎲 Game Master' : msg.rpType === 'action' ? `⚔️ ${roleplayConfig?.characterName || 'Player'}` : getResponderName(msg)}
                        {' • '}
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {msg.role === 'user' && !roleplayMode && editingMessageId !== msg.id && !isStreaming && (
                        <button
                          onClick={() => {
                            setEditingMessageId(msg.id)
                            setEditingMessageText(msg.content)
                          }}
                          className="btn-icon"
                          title={t.app.editMessage}
                          type="button"
                          style={{ padding: '0.1rem', background: 'transparent', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', opacity: 0.6 }}
                          onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                          onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
                        >
                          <SquarePen size={12} />
                        </button>
                      )}
                    </span>
                  )}
                </>
              )}
            </div>
          )
        })}
        {isStreaming && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            <RefreshCw size={12} className="animate-spin" />
            <span>{roleplayMode ? '🎲 Game Master is narrating...' : `${getProviderLabel(activeProvider)} ${t.app.streamingChanges}`}</span>
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
            <Paperclip size={10} /> {t.app.referenceContext}
          </span>
          <button
            onClick={() => setWholeBookMode(!wholeBookMode)}
            className={`reference-tag whole-book ${wholeBookMode ? 'active' : ''}`}
            disabled={isStreaming}
            title={t.app.wholeBookHint}
            type="button"
          >
            📚 {t.app.wholeBookTag}
          </button>
          {!wholeBookMode && documents
            .filter(doc => doc.id !== activeDocumentId)
            .map(doc => {
              const isPinned = pinnedReferenceIds.includes(doc.id)
              const isBlocked = blockedReferenceIds.includes(doc.id)
              const isAuto = !isPinned && !isBlocked && (selectionPreview?.autoIds.includes(doc.id) ?? false)
              const stateClass = isPinned ? 'active' : isBlocked ? 'blocked' : isAuto ? 'auto' : ''
              const hint = isPinned
                ? t.app.referencePinnedHint
                : isBlocked
                  ? t.app.referenceBlockedHint
                  : isAuto
                    ? t.app.referenceAutoHint
                    : t.app.referenceNeutralHint
              return (
                <button
                  key={doc.id}
                  onClick={() => cycleReferenceState(doc.id)}
                  className={`reference-tag ${stateClass}`}
                  disabled={isStreaming}
                  title={hint}
                  type="button"
                >
                  {isAuto ? '✨ ' : ''}{doc.title}
                </button>
              )
            })
          }
          {!wholeBookMode && selectionPreview && selectionPreview.attachedIds.length > 0 && (
            <span className="reference-budget-chip" title={t.app.referenceBudgetHint}>
              ~{Math.ceil(selectionPreview.estimatedChars / 1000)}k / 60k
            </span>
          )}
          {wholeBookMode && (
            <span className="reference-budget-chip" title={t.app.wholeBookHint}>
              ~{Math.ceil(documents.filter(d => d.id !== activeDocumentId).reduce((sum, d) => sum + d.content.length, 0) / 1000)}k
            </span>
          )}
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
                        alert(t.app.maxImages)
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
                  fontFamily: 'var(--font-ui)',
                  fontSize: '0.95rem',
                  lineHeight: 1.5,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  width: '100%'
                }}
              >
                {roleplayMode && roleplayConfig
                  ? `What do you do, ${roleplayConfig.characterName}?`
                  : t.app.instructPlaceholder
                    .replace('{provider}', activeProvider === 'grok' ? 'Grok' : activeProvider.charAt(0).toUpperCase() + activeProvider.slice(1))
                    .replace('{model}', activeConfig.model)
                }
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn-icon"
            title={t.app.uploadImage}
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
            style={{ padding: '0.5rem', color: 'var(--text-secondary)' }}
          >
            <Image size={18} />
          </button>
          <button
            type="button"
            className="btn-icon"
            title={t.app.pasteImage}
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
              title={t.app.stopGeneration}
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
              title={t.app.sendInstruction}
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

    {/* Roleplay Setup Modal */}
    <RoleplaySetupModal
      isOpen={isRpSetupOpen}
      onClose={() => setIsRpSetupOpen(false)}
      onStartGame={handleStartRpGame}
    />
    </>
  )
}
