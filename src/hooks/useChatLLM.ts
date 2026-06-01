import { useState, useRef, useCallback } from 'react'
import { Editor } from '@tiptap/react'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import { useAppStore } from '../store/useAppStore'
import { streamLLM, type LLMMessage } from '../services/llm'
import { getTimestampId, stripIncompleteEndTag } from '../utils/text'
import { diffHtml } from '../utils/diff'

interface UseChatLLMProps {
  activeEditor: Editor | null
  selectedText: string
  uploadedImages: string[]
  setUploadedImages: (images: string[]) => void
  layoutMode: string
  setIsChatExpanded: (expanded: boolean) => void
  forceSave: () => void
  setSaveStatus: (status: 'saved' | 'unsaved') => void
}

export function useChatLLM({
  activeEditor,
  selectedText,
  uploadedImages,
  setUploadedImages,
  layoutMode,
  setIsChatExpanded,
  forceSave,
  setSaveStatus
}: UseChatLLMProps) {
  // Local state
  const [chatInput, setChatInput] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingMessageText, setEditingMessageText] = useState('')

  // Refs
  const chatInputRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const accumulatedTextRef = useRef('')
  const selectionRangeRef = useRef<{ from: number; to: number } | null>(null)
  const selectionEndRef = useRef<number | null>(null)
  const originalSelectedTextRef = useRef<string>('')
  const imagePlaceholdersRef = useRef<{ placeholder: string; tag: string }[]>([])

  // Simple image preservation during LLM streaming
  const preserveImagesWithPlaceholders = useCallback((html: string) => {
    let replacedHtml = html
    const imgRegex = /<img[^>]+>/g
    const matches = html.match(imgRegex)
    if (matches) {
      matches.forEach((match) => {
        let existing = imagePlaceholdersRef.current.find(item => item.tag === match)
        if (!existing) {
          const placeholder = `{{IMAGE_PLACEHOLDER_${imagePlaceholdersRef.current.length}}}`
          existing = { placeholder, tag: match }
          imagePlaceholdersRef.current.push(existing)
        }
        replacedHtml = replacedHtml.replace(match, existing.placeholder)
      })
    }
    return replacedHtml
  }, [])

  const restoreImagesFromPlaceholders = useCallback((html: string) => {
    let restored = html
    imagePlaceholdersRef.current.forEach(item => {
      restored = restored.replace(new RegExp(item.placeholder, 'g'), item.tag)
    })
    return restored
  }, [])

  // Build static system prompt
  const buildStaticSystemPrompt = useCallback((): LLMMessage => {
    return {
      role: 'system',
      content: `You are an elite creative writing assistant and document editor. You help authors write, format, rewrite, and structure their books/documents.

CRITICAL INSTRUCTIONS FOR ALL RESPONSES:
1. ALWAYS communicate with the user normally in the chat interface. You are a helpful assistant.
2. If the user asks you to modify the current document or write new content for the document, you MUST use the <canvas> or <selection_replace> tags to apply the changes.
3. Use <selection_replace>...</selection_replace> if the user has selected specific text in the editor and wants you to rewrite, expand, or fix it. Only put the new text for the selection inside the tag. Do NOT include the surrounding text.
4. Use <canvas>...</canvas> for all other document additions, full rewrites, or structural changes. When using <canvas>, output the ENTIRE updated document content inside the tags. You must output the entire document, not just the new parts.
5. You MUST return beautifully formatted HTML inside the <canvas> or <selection_replace> tags.
   - Use <h1>, <h2>, <h3> for headings.
   - Use <p> for paragraphs.
   - Use <blockquote> for quotes.
   - Use <strong>, <em> for emphasis.
   - Use <ul>, <ol>, <li> for lists.
6. The user will provide you with the "CURRENT ACTIVE DOCUMENT CONTENT". This is the HTML of the document they are currently working on. You must preserve existing formatting unless asked to change it.
7. Any text outside of <canvas> or <selection_replace> tags will be displayed as a normal chat message to the user.
8. Do NOT use markdown inside the <canvas> or <selection_replace> tags. Use ONLY HTML.
9. ONLY use <selection_replace> if the user's prompt explicitly includes "CURRENT SELECTED TEXT". Otherwise, use <canvas> and rewrite the full document.

EXAMPLES:

User: "Write a short paragraph about a cat."
Assistant: Sure! Here is a paragraph about a cat.
<canvas>
<h1>The Cat</h1>
<p>The cat is a small, furry mammal...</p>
</canvas>

User (with selection "The cat"): "Make this more descriptive."
Assistant: I have made the description more vivid.
<selection_replace>
The fluffy orange tabby cat
</selection_replace>`
    }
  }, [])

  // Build dynamic context (reference docs + active doc)
  const buildDynamicContext = useCallback((finalReferenceIds: string[]): LLMMessage => {
    const s = useAppStore.getState()
    
    // Build context string for explicitly selected secondary documents
    const referenceDocsContext = finalReferenceIds
      .map(id => {
        const doc = s.documents.find(d => d.id === id)
        if (!doc) return ''
        const textContent = doc.content.replace(/<[^>]*>?/gm, '')
        return `--- DOCUMENT: ${doc.title} ---\n${textContent}\n`
      })
      .filter(Boolean)
      .join('\n')

    const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
    const cleanActiveContent = preserveImagesWithPlaceholders(activeDoc?.content || '')

    if (selectedText) {
      return {
        role: 'user',
        content: `I have selected the following text in the document. I want you to focus your action on this specific text.
${referenceDocsContext ? `\nREFERENCED DOCUMENT CONTEXTS (Read-only, do not modify these but use them for details/consistency):\n${referenceDocsContext}` : ''}
CURRENT SELECTED TEXT:
"""
${selectedText}
"""

CURRENT ACTIVE DOCUMENT CONTENT (For context):
"""
${cleanActiveContent}
"""`
      }
    } else {
      return {
        role: 'user',
        content: `Here is the current state of my document.
${referenceDocsContext ? `\nREFERENCED DOCUMENT CONTEXTS (Read-only, do not modify these but use them for details/consistency):\n${referenceDocsContext}` : ''}

CURRENT ACTIVE DOCUMENT CONTENT (This is the ONLY document you can update):
"""
${cleanActiveContent}
"""`
      }
    }
  }, [selectedText, preserveImagesWithPlaceholders])

  // Shared LLM Streaming engine
  const startLLMStreaming = useCallback(async (
    apiMessages: LLMMessage[],
    assistantMsgId: string,
    originalDocContent: string,
    attachmentsText: string,
    estimatedInputTokens: number
  ) => {
    const s = useAppStore.getState()
    
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
        { ...s.providerConfigs[s.activeProvider], provider: s.activeProvider, debug: s.debugMode, signal },
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
            s.setMessages(
              latestMessages.map(m => {
                if (m.id === assistantMsgId) {
                  return { ...m, content: displayChatText }
                }
                return m
              })
            )

            if (isSelectionEdit) {
              const cleanedText = stripIncompleteEndTag(selectionReplaceText)
              if (cleanedText && activeEditor && selectionRangeRef.current) {
                const { from } = selectionRangeRef.current
                const currentEnd = selectionEndRef.current ?? selectionRangeRef.current.to

                const restoredText = restoreImagesFromPlaceholders(cleanedText)
                const tempDiv = document.createElement('div')
                tempDiv.innerHTML = restoredText
                const slice = ProseMirrorDOMParser.fromSchema(activeEditor.state.schema).parseSlice(tempDiv)

                const tr = activeEditor.state.tr
                tr.replace(from, currentEnd, slice)
                activeEditor.view.dispatch(tr)

                selectionEndRef.current = from + slice.size
                setSaveStatus('unsaved')
              }
            } else if (canvasText.trim()) {
              setSaveStatus('unsaved')
            }
          },
          onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }) => {
            s.setStreaming(false)

            let finalInputTokens = estimatedInputTokens
            let finalOutputTokens = Math.ceil(fullText.length / 4)
            let cacheHits = 0

            if (usage) {
              finalInputTokens = usage.promptTokens
              finalOutputTokens = usage.completionTokens
              cacheHits = usage.cachedPromptTokens || 0
            }

            s.addSessionTokens(finalInputTokens, finalOutputTokens, cacheHits)

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
            s.setMessages(
              latestMessages.map(m => {
                if (m.id === assistantMsgId) {
                  return { ...m, content: displayChatText }
                }
                return m
              })
            )

            if (isSelectionEdit) {
              const cleanedText = stripIncompleteEndTag(finalSelectionReplaceText)
              if (cleanedText && activeEditor && selectionRangeRef.current) {
                const restoredText = restoreImagesFromPlaceholders(cleanedText)
                const diffed = diffHtml(originalSelectedTextRef.current, restoredText)
                const { from } = selectionRangeRef.current
                const currentEnd = selectionEndRef.current ?? selectionRangeRef.current.to

                const tempDiv = document.createElement('div')
                tempDiv.innerHTML = diffed
                const slice = ProseMirrorDOMParser.fromSchema(activeEditor.state.schema).parseSlice(tempDiv)

                const tr = activeEditor.state.tr
                tr.replace(from, currentEnd, slice)
                activeEditor.view.dispatch(tr)

                s.updateActiveDocument({ content: activeEditor.getHTML() })
              }
            } else if (finalCanvasText.trim()) {
              const restoredText = restoreImagesFromPlaceholders(finalCanvasText)
              const diffed = diffHtml(originalDocContent, restoredText)
              s.updateActiveDocument({ content: diffed })
            }
            forceSave()
          },
          onError: (err: Error) => {
            s.setStreaming(false)
            
            const isAbort = err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('cancel')
            if (isAbort) {
              forceSave()
              return
            }

            setErrorMsg(err.message)
            
            const displayChatText = attachmentsText
              ? `${attachmentsText}\n\n⚠️ Error during stream: ${err.message}`
              : `⚠️ Error during stream: ${err.message}`

            const latestMessages = useAppStore.getState().messages
            s.setMessages(
              latestMessages.map(m => {
                if (m.id === assistantMsgId) {
                  return { ...m, content: displayChatText }
                }
                return m
              })
            )

            s.updateActiveDocument({ content: originalDocContent })
            forceSave()
          }
        }
      )
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      s.setStreaming(false)
      setErrorMsg(err.message || 'Failed to initialize LLM stream.')
    }
  }, [activeEditor, selectedText, restoreImagesFromPlaceholders, forceSave, setSaveStatus])

  // Send message handler
  const handleSendMessage = useCallback(async (e?: React.FormEvent, customPrompt?: string) => {
    e?.preventDefault()
    
    const s = useAppStore.getState()
    const promptText = customPrompt ? customPrompt.trim() : chatInput.trim()
    if (!promptText || s.isStreaming) return

    imagePlaceholdersRef.current = []

    if (layoutMode === 'portrait') {
      setIsChatExpanded(true)
    }

    setErrorMsg(null)
    const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
    const originalDocContent = activeDoc?.content || ''
    
    s.createVersionSnapshot(`Auto-save before: "${promptText.substring(0, 30)}${promptText.length > 30 ? '...' : ''}"`)
    
    if (!customPrompt) {
      setChatInput('')
      if (chatInputRef.current) {
        chatInputRef.current.innerHTML = ''
      }
    }

    const autoDetectedIds: string[] = []
    s.documents.forEach(doc => {
      if (doc.id !== s.activeDocumentId) {
        const cleanTitle = doc.title.toLowerCase().replace(/chapter\s*\d+\s*:\s*/g, '')
        if (
          promptText.toLowerCase().includes(doc.title.toLowerCase()) ||
          (cleanTitle.length > 3 && promptText.toLowerCase().includes(cleanTitle))
        ) {
          autoDetectedIds.push(doc.id)
        }
      }
    })

    const finalReferenceIds = Array.from(new Set([...s.selectedReferenceIds, ...autoDetectedIds]))

    const userMsgId = getTimestampId('user')
    const userMsg = {
      id: userMsgId,
      role: 'user' as const,
      content: promptText,
      images: uploadedImages.length > 0 ? uploadedImages : undefined,
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    }
    s.addMessage(userMsg)
    setUploadedImages([])

    const assistantMsgId = getTimestampId('assistant')
    const assistantPlaceholder = {
      id: assistantMsgId,
      role: 'assistant' as const,
      content: 'Thinking...',
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    }
    s.addMessage(assistantPlaceholder)
    s.setStreaming(true)

    accumulatedTextRef.current = ''

    const staticSystem = buildStaticSystemPrompt()
    const dynamicContext = buildDynamicContext(finalReferenceIds)
    const contextAck: LLMMessage = { role: 'assistant', content: 'Understood. I have the document context. What would you like me to do?' }

    const historyMessages: LLMMessage[] = s.messages
      .filter(m => m.id !== 'welcome')
      .map(m => ({
        role: m.role,
        content: m.content,
        images: m.images
      }))

    historyMessages.push({
      role: 'user',
      content: promptText,
      images: userMsg.images
    })

    const apiMessages = [staticSystem, dynamicContext, contextAck, ...historyMessages]
    const estimatedInputTokens = Math.ceil(JSON.stringify(apiMessages).length / 4)

    const attachmentsText = finalReferenceIds
      .map(id => {
        const doc = s.documents.find(d => d.id === id)
        return doc ? `[Attached Context: ${doc.title}]` : ''
      })
      .filter(Boolean)
      .join('\n')

    await startLLMStreaming(apiMessages, assistantMsgId, originalDocContent, attachmentsText, estimatedInputTokens)
  }, [chatInput, uploadedImages, layoutMode, setIsChatExpanded, setUploadedImages, buildStaticSystemPrompt, buildDynamicContext, startLLMStreaming])

  // Edit and Resubmit message handler
  const handleResubmitMessage = useCallback(async (msgId: string, newContent: string) => {
    const s = useAppStore.getState()
    const trimmed = newContent.trim()
    if (!trimmed || s.isStreaming) return

    imagePlaceholdersRef.current = []

    if (layoutMode === 'portrait') {
      setIsChatExpanded(true)
    }

    setEditingMessageId(null)
    setErrorMsg(null)

    const targetIdx = s.messages.findIndex(m => m.id === msgId)
    if (targetIdx === -1) return

    const truncatedMessages = s.messages.slice(0, targetIdx + 1).map((m, idx) => {
      if (idx === targetIdx) {
        return { ...m, content: trimmed, timestamp: new Date().toISOString() }
      }
      return m
    })

    const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
    const originalDocContent = activeDoc?.content || ''
    s.createVersionSnapshot(`Auto-save before edit: "${trimmed.substring(0, 30)}${trimmed.length > 30 ? '...' : ''}"`)

    s.setMessages(truncatedMessages)

    const assistantMsgId = getTimestampId('assistant')
    const assistantPlaceholder = {
      id: assistantMsgId,
      role: 'assistant' as const,
      content: 'Thinking...',
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    }
    s.setMessages([...truncatedMessages, assistantPlaceholder])
    s.setStreaming(true)

    accumulatedTextRef.current = ''

    const autoDetectedIds: string[] = []
    s.documents.forEach(doc => {
      if (doc.id !== s.activeDocumentId) {
        const cleanTitle = doc.title.toLowerCase().replace(/chapter\s*\d+\s*:\s*/g, '')
        if (
          trimmed.toLowerCase().includes(doc.title.toLowerCase()) ||
          (cleanTitle.length > 3 && trimmed.toLowerCase().includes(cleanTitle))
        ) {
          autoDetectedIds.push(doc.id)
        }
      }
    })

    const finalReferenceIds = Array.from(new Set([...s.selectedReferenceIds, ...autoDetectedIds]))

    const staticSystem = buildStaticSystemPrompt()
    const dynamicContext = buildDynamicContext(finalReferenceIds)
    const contextAck: LLMMessage = { role: 'assistant', content: 'Understood. I have the document context. What would you like me to do?' }

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
        const doc = s.documents.find(d => d.id === id)
        return doc ? `[Attached Context: ${doc.title}]` : ''
      })
      .filter(Boolean)
      .join('\n')

    await startLLMStreaming(apiMessages, assistantMsgId, originalDocContent, attachmentsText, estimatedInputTokens)
  }, [layoutMode, setIsChatExpanded, buildStaticSystemPrompt, buildDynamicContext, startLLMStreaming])

  // Stop generation
  const handleStopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    useAppStore.getState().setStreaming(false)
  }, [])

  return {
    chatInput,
    setChatInput,
    chatInputRef,
    chatEndRef,
    errorMsg,
    setErrorMsg,
    editingMessageId,
    setEditingMessageId,
    editingMessageText,
    setEditingMessageText,
    handleSendMessage,
    handleResubmitMessage,
    handleStopGeneration
  }
}
