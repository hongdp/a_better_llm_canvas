import { useState, useRef, useCallback, useEffect } from 'react'
import { Editor } from '@tiptap/react'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import { useAppStore } from '../store/useAppStore'
import { streamLLM, type LLMMessage } from '../services/llm'
import { getTimestampId, stripIncompleteEndTag, stripBlankParagraphs, extractTaggedBlock, validateCanvasReplacement, parseEditBlocks, applyEditBlocks, parseLookupRequest } from '../utils/text'
import { diffHtml } from '../utils/diff'
import { trimHistoryForContext, stripChatDisplayArtifacts, truncateWithNotice, htmlToPlainText, buildAttachmentsLabel, resolveLookupTitles } from '../utils/llmContext'
import { buildChapterIndex, buildWholeBookDigest, packChaptersIntoBatches, WHOLE_BOOK_CONTEXT_CHARS } from '../utils/chapterIndex'
import { selectReferenceChapters } from '../utils/contextSelection'
import { enqueueStaleSummaryRefreshes } from '../services/chapterSummaries'

// Approximate character budget for chat history sent to the LLM. History is
// windowed (most recent first) so long sessions don't grow the prompt without
// bound; the active document is always sent in full separately.
const MAX_HISTORY_CHARS = 80_000
// Base64 images are only re-sent for the most recent messages — older ones
// dominate token cost while rarely being referenced again.
const KEEP_IMAGES_IN_LAST_MESSAGES = 4
// Per-document cap for read-only reference documents attached as context.
const MAX_REFERENCE_DOC_CHARS = 20_000
// Agentic lookup loop guards: how many <lookup> continuation rounds a single
// user request may trigger, and how many chapters each round may attach.
const MAX_LOOKUP_ROUNDS = 2
const MAX_LOOKUP_CHAPTERS_PER_ROUND = 3

// State threaded through the agentic lookup loop so a continuation round can
// rebuild the SAME request with more chapters attached. `prefixMessages`
// (system + windowed history) is reused verbatim — the retry only changes the
// final user message, keeping the provider prompt-cache prefix intact.
interface LookupLoopContext {
  promptText: string
  images?: string[]
  prefixMessages: LLMMessage[]
  attachedIds: string[]
  autoIds: string[]
  round: number
}

// Whole-book cost consent (spec §6): rendered as an inline 3-option panel in
// ChatPanel; handleSendMessage awaits the user's choice BEFORE anything
// enters the chat, so cancelling has zero side effects.
export interface WholeBookConsentRequest {
  approxTokensK: number
  chapterCount: number
  /** Total LLM calls for the batched (Rung 2) path; absent for Rung 1. */
  batchCount?: number
}
export type WholeBookConsentChoice = 'proceed' | 'fast' | 'cancel'

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
  const [wholeBookConsent, setWholeBookConsent] = useState<WholeBookConsentRequest | null>(null)
  const consentResolveRef = useRef<((choice: WholeBookConsentChoice) => void) | null>(null)
  // Sticky whole-book mode asks for consent only on its first send; the ref
  // resets whenever a send happens with the mode off.
  const stickyConsentGivenRef = useRef(false)

  const requestWholeBookConsent = useCallback((req: WholeBookConsentRequest): Promise<WholeBookConsentChoice> => {
    setWholeBookConsent(req)
    return new Promise<WholeBookConsentChoice>(resolve => {
      consentResolveRef.current = resolve
    })
  }, [])

  const resolveWholeBookConsent = useCallback((choice: WholeBookConsentChoice) => {
    setWholeBookConsent(null)
    consentResolveRef.current?.(choice)
    consentResolveRef.current = null
  }, [])

  // Refs
  const chatInputRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const accumulatedTextRef = useRef('')
  const selectionRangeRef = useRef<{ from: number; to: number } | null>(null)
  const selectionEndRef = useRef<number | null>(null)
  const originalSelectedTextRef = useRef<string>('')
  const imagePlaceholdersRef = useRef<{ placeholder: string; tag: string }[]>([])
  // Chapters attached on the previous turn — feeds the scorer's continuity
  // signal so a chapter under discussion isn't dropped mid-conversation.
  const previousAttachedIdsRef = useRef<string[]>([])
  // Self-reference for the lookup loop: onDone re-invokes the streaming
  // engine, which can't reference its own useCallback binding directly.
  const startLLMStreamingRef = useRef<
    ((apiMessages: LLMMessage[], assistantMsgId: string, originalDocContent: string, attachmentsText: string, estimatedInputTokens: number, lookupCtx?: LookupLoopContext) => Promise<void>) | null
  >(null)
  // Throttles the live selection-edit preview: re-parsing + replacing the whole
  // (growing) replacement on every streamed token is O(n²) and re-renders
  // ProseMirror per token, which stutters once the output passes a few
  // paragraphs. onDone always applies the final result, so coalescing the
  // intermediate previews is safe.
  const lastSelectionPreviewRef = useRef(0)

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

  // Build the system prompt: a static instruction block (kept stable so
  // provider-side prompt caching works) plus the user's selected system
  // prompt preset, which only changes when they pick a different preset.
  const buildSystemPrompt = useCallback((): LLMMessage => {
    const s = useAppStore.getState()
    const preset = s.customSystemPrompts.find(p => p.id === s.activeSystemPromptId)
    const customInstructions = preset?.content?.trim()
    return {
      role: 'system',
      content: `You are an elite creative writing assistant and document editor. You help authors write, format, rewrite, and structure their books/documents.

CRITICAL INSTRUCTIONS FOR ALL RESPONSES:
1. ALWAYS communicate with the user normally in the chat interface. You are a helpful assistant.
2. If the user asks you to modify the current document, you MUST apply the changes using <edit>, <selection_replace>, or <canvas> tags (chosen per the rules below).
3. Use <selection_replace>...</selection_replace> if the user has selected specific text in the editor and wants you to rewrite, expand, or fix it. Only put the new text for the selection inside the tag. Do NOT include the surrounding text.
4. PREFER <edit> blocks for targeted changes to specific parts of an existing document (rewriting a sentence/paragraph, fixing wording, inserting or removing a section). Emit ONLY the changed regions — never the whole document. Each change is one block in this EXACT format:
   <edit>
   <<<<<<< SEARCH
   (exact HTML copied verbatim from the CURRENT ACTIVE DOCUMENT CONTENT)
   =======
   (the new HTML that replaces it)
   >>>>>>> REPLACE
   </edit>
   - The SEARCH text MUST be copied EXACTLY, character-for-character, from the CURRENT ACTIVE DOCUMENT CONTENT: same tags (including inline tags like <strong>/<em> and their attributes), same HTML entities (&nbsp;, &amp;, ...), same punctuation and quote characters. Do NOT paraphrase, re-wrap, or "clean up" the copied HTML — any difference prevents the edit from being located.
   - Prefer starting SEARCH at a block boundary (e.g. from the opening <p> or <h2> tag) and spanning whole blocks. Include enough surrounding context to make it unique.
   - Emit multiple <edit> blocks for multiple separate changes.
   - To delete content, leave the REPLACE section empty. To insert, SEARCH for an existing nearby element and REPLACE it with itself plus the new content.
5. Use <canvas>...</canvas> ONLY for brand-new documents, full rewrites, or heavy restructuring where most of the document changes. When using <canvas>, output the ENTIRE updated document content inside the tags — never abbreviate or use placeholders like "<!-- unchanged -->".
6. You MUST return beautifully formatted HTML inside all tags.
   - Use <h1>, <h2>, <h3> for headings.
   - Use <p> for paragraphs.
   - Use <blockquote> for quotes.
   - Use <strong>, <em> for emphasis.
   - Use <ul>, <ol>, <li> for lists.
7. The user will provide you with the "CURRENT ACTIVE DOCUMENT CONTENT". This is the HTML of the document they are currently working on. You must preserve existing formatting unless asked to change it.
8. Any text outside of the tags will be displayed as a normal chat message to the user.
9. Do NOT use markdown inside any tag. Use ONLY HTML.
10. ONLY use <selection_replace> if the user's prompt explicitly includes "CURRENT SELECTED TEXT". Otherwise, prefer <edit> for targeted changes, and <canvas> for full rewrites.

EXAMPLES:

User: "Write a short paragraph about a cat." (empty document)
Assistant: Sure! Here is a paragraph about a cat.
<canvas>
<h1>The Cat</h1>
<p>The cat is a small, furry mammal...</p>
</canvas>

User: "Make the second paragraph more vivid." (document already has content)
Assistant: I've made that paragraph more vivid.
<edit>
<<<<<<< SEARCH
<p>The cat sat on the mat.</p>
=======
<p>The sleek tabby stretched lazily across the sun-warmed mat.</p>
>>>>>>> REPLACE
</edit>

User (with selection "The cat"): "Make this more descriptive."
Assistant: I have made the description more vivid.
<selection_replace>
The fluffy orange tabby cat
</selection_replace>${s.agenticLookupEnabled && s.documents.length > 1 ? `

CHAPTER LOOKUP:
The user message may include a CHAPTER INDEX listing every chapter of the book with a one-line summary. If answering well requires the FULL TEXT of chapters that are NOT included in your context, respond with ONLY this tag and nothing else:
<lookup chapters="Chapter 3: Ashfall; Chapter 7: Return" reason="need the betrayal details for continuity"></lookup>
- Copy chapter titles EXACTLY as they appear in CHAPTER INDEX, separated by semicolons.
- The requested chapters will be attached and your request retried automatically.
- Never guess or invent the content of a chapter you have not been shown; look it up instead.
- Do NOT use <lookup> for chapters already provided in your context.` : ''}${customInstructions ? `

USER'S CUSTOM WRITING INSTRUCTIONS (apply these to all content you write):
${customInstructions}` : ''}`
    }
  }, [])

  // Build the volatile document context (reference docs + active doc).
  // Returned as a string that is merged into the FINAL user message: keeping
  // it after the (stable) chat history preserves provider prompt-cache
  // prefixes across turns, and keeps the document close to the request so
  // <edit> SEARCH blocks are copied from nearby, current content.
  // Whole-book options: `perDocChars` lifts the per-doc cap for Rung 1
  // attach-all; `includeWholeBookDigest` swaps the compact index for the full
  // structural digest (fast mode); `notesBlock` carries Rung 2 batch notes.
  const buildDynamicContext = useCallback((
    finalReferenceIds: string[],
    opts?: { perDocChars?: number; includeWholeBookDigest?: boolean; notesBlock?: string }
  ): string => {
    const s = useAppStore.getState()

    // Layer 0: compact index of every chapter (title + summary digest) so the
    // model always has whole-book awareness even for unattached chapters.
    // Empty for single-document books.
    const chapterIndex = opts?.includeWholeBookDigest
      ? buildWholeBookDigest(s.documents, s.activeDocumentId)
      : buildChapterIndex(s.documents, s.activeDocumentId)
    let chapterIndexBlock = chapterIndex ? `${chapterIndex}\n\n` : ''
    if (opts?.notesBlock) {
      chapterIndexBlock += `BOOK ANALYSIS NOTES (compiled by reading every chapter of this book in batches for this request — treat them as your own reading of the full text):\n${opts.notesBlock}\n\n`
    }

    // Build context string for explicitly selected secondary documents
    const perDocCap = opts?.perDocChars ?? MAX_REFERENCE_DOC_CHARS
    const referenceDocsContext = finalReferenceIds
      .map(id => {
        const doc = s.documents.find(d => d.id === id)
        if (!doc) return ''
        const textContent = truncateWithNotice(htmlToPlainText(doc.content), perDocCap)
        return `--- DOCUMENT: ${doc.title} ---\n${textContent}\n`
      })
      .filter(Boolean)
      .join('\n')

    const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
    const cleanActiveContent = preserveImagesWithPlaceholders(activeDoc?.content || '')

    if (selectedText) {
      const cleanSelectedText = preserveImagesWithPlaceholders(selectedText)
      return `I have selected the following text in the document. I want you to focus your action on this specific text.
${chapterIndexBlock}${referenceDocsContext ? `\nREFERENCED DOCUMENT CONTEXTS (Read-only, do not modify these but use them for details/consistency):\n${referenceDocsContext}` : ''}
CURRENT SELECTED TEXT:
"""
${cleanSelectedText}
"""

CURRENT ACTIVE DOCUMENT CONTENT (For context):
"""
${cleanActiveContent}
"""`
    } else {
      return `Here is the current state of my document.
${chapterIndexBlock}${referenceDocsContext ? `\nREFERENCED DOCUMENT CONTEXTS (Read-only, do not modify these but use them for details/consistency):\n${referenceDocsContext}` : ''}

CURRENT ACTIVE DOCUMENT CONTENT (This is the ONLY document you can update):
"""
${cleanActiveContent}
"""`
    }
  }, [selectedText, preserveImagesWithPlaceholders])

  // Whole-book Rung 2: client-orchestrated map-reduce. Reads the book in
  // book-order batches, carrying a running-notes scratchpad between rounds;
  // the caller feeds the final notes into a normal request. Rounds are
  // transient (only the status bubble is visible; nothing enters history).
  // Returns the notes, or null when aborted/failed.
  const runWholeBookBatches = useCallback(async (
    promptText: string,
    batches: { id: string; title: string; content: string }[][],
    assistantMsgId: string,
    perBatchChars: number
  ): Promise<string | null> => {
    const s = useAppStore.getState()
    if (abortControllerRef.current) abortControllerRef.current.abort()
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    const setStatus = (text: string) => {
      useAppStore.setState((state) => ({
        messages: state.messages.map(m => m.id === assistantMsgId ? { ...m, content: text } : m)
      }))
    }

    let notes = ''
    for (let i = 0; i < batches.length; i++) {
      if (signal.aborted) return null
      const batch = batches[i]
      const label = batch.length === 1
        ? `"${batch[0].title}"`
        : `"${batch[0].title}" – "${batch[batch.length - 1].title}"`
      setStatus(`📚 Reading ${label} (batch ${i + 1}/${batches.length})…`)

      const batchText = batch
        .map(doc => `--- DOCUMENT: ${doc.title} ---\n${truncateWithNotice(htmlToPlainText(doc.content), perBatchChars)}`)
        .join('\n\n')
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: 'You are analyzing a book chapter-by-chapter in batches to complete the user\'s task. Each round you receive your running notes and a new batch of chapters. Update and extend the notes with everything from this batch that matters for the task (structure, plot, entities, facts, quotes). Output ONLY the updated complete notes as plain text. Do NOT produce the final answer yet.'
        },
        {
          role: 'user',
          content: `TASK (do not answer yet — only update notes):\n${promptText}\n\nRUNNING NOTES (from previous batches):\n${notes || '(none yet — this is the first batch)'}\n\nNEW CHAPTERS (batch ${i + 1} of ${batches.length}):\n${batchText}`
        }
      ]

      const batchResult = await new Promise<string | null>((resolve) => {
        streamLLM(
          messages,
          { ...s.providerConfigs[s.activeProvider], provider: s.activeProvider, debug: s.debugMode, signal },
          {
            onChunk: () => {},
            onDone: (fullText, usage) => {
              useAppStore.getState().addSessionTokens(
                usage?.promptTokens ?? Math.ceil(JSON.stringify(messages).length / 4),
                usage?.completionTokens ?? Math.ceil(fullText.length / 4),
                usage?.cachedPromptTokens ?? 0
              )
              resolve(fullText.trim() || null)
            },
            onError: (err) => {
              const isAbort = err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('cancel')
              if (!isAbort) {
                console.error(`[WholeBook] batch ${i + 1}/${batches.length} failed:`, err.message)
              }
              resolve(null)
            }
          }
        )
      })

      if (batchResult === null) {
        // Abort or failure: bail out; the caller reports to the user.
        return null
      }
      notes = batchResult
    }
    return notes
  }, [])

  // Shared LLM Streaming engine. `lookupCtx` (when set) arms the agentic
  // chapter-lookup loop: a response consisting of a <lookup> tag re-issues
  // the same request with the requested chapters attached (bounded rounds).
  const startLLMStreaming = useCallback(async (
    apiMessages: LLMMessage[],
    assistantMsgId: string,
    originalDocContent: string,
    attachmentsText: string,
    estimatedInputTokens: number,
    lookupCtx?: LookupLoopContext
  ) => {
    const s = useAppStore.getState()
    
    // Abort any existing stream just in case
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    // Reset the live-preview throttle so the first chunk renders immediately.
    lastSelectionPreviewRef.current = 0

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
            // First sign of an <edit> block (open tag or a SEARCH conflict marker).
            const editMatchIdx = raw.search(/<edit\b|<{5,}\s*SEARCH/i)

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
            } else if (editMatchIdx !== -1 && (canvasIdx === -1 || editMatchIdx < canvasIdx)) {
              // Edit blocks are applied on completion; during streaming just hide
              // the noisy SEARCH/REPLACE markup and show the surrounding chat.
              chatText = raw.substring(0, editMatchIdx).trim()
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

            // Prepend visual attachment details to conversational text. A
            // streaming <lookup> request is protocol chatter, not an answer —
            // show a neutral status instead of the raw tag.
            const displayChatText = lookupCtx && raw.trimStart().toLowerCase().startsWith('<lookup')
              ? '📖 Checking the chapter index…'
              : attachmentsText
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
              // Throttle the live preview: applying it on every token re-parses
              // the whole growing replacement and re-renders ProseMirror each
              // time (O(n²)), stuttering past a few paragraphs. ~60ms ≈ 16fps is
              // smooth; the final, exact result is applied in onDone regardless.
              const SELECTION_PREVIEW_THROTTLE_MS = 60
              const now = Date.now()
              const cleanedText = stripIncompleteEndTag(selectionReplaceText)
              if (
                cleanedText &&
                activeEditor &&
                selectionRangeRef.current &&
                now - lastSelectionPreviewRef.current >= SELECTION_PREVIEW_THROTTLE_MS
              ) {
                lastSelectionPreviewRef.current = now
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
            let finalInputTokens = estimatedInputTokens
            let finalOutputTokens = Math.ceil(fullText.length / 4)
            let cacheHits = 0

            if (usage) {
              finalInputTokens = usage.promptTokens
              finalOutputTokens = usage.completionTokens
              cacheHits = usage.cachedPromptTokens || 0
            }

            // Every round costs — account before deciding whether to continue.
            s.addSessionTokens(finalInputTokens, finalOutputTokens, cacheHits)

            // Agentic lookup continuation: the model asked for more chapters
            // instead of answering. Attach them and re-issue the SAME request.
            // Rounds are transient — this response is never persisted (the
            // assistant bubble is overwritten in place) and streaming stays on.
            if (lookupCtx) {
              const lookup = parseLookupRequest(fullText)
              if (lookup) {
                const sNow = useAppStore.getState()
                const requestedIds = lookup.wantsAll
                  ? sNow.documents.filter(d => d.id !== sNow.activeDocumentId).map(d => d.id)
                  : resolveLookupTitles(lookup.titles, sNow.documents, sNow.activeDocumentId)
                const newIds = requestedIds
                  .filter(id => !lookupCtx.attachedIds.includes(id))
                  .filter(id => {
                    const d = sNow.documents.find(doc => doc.id === id)
                    return d !== undefined && d.contentLoaded !== false && d.content.length > 0
                  })
                  .slice(0, MAX_LOOKUP_CHAPTERS_PER_ROUND)

                const canContinue = lookupCtx.round < MAX_LOOKUP_ROUNDS && newIds.length > 0
                const combinedIds = canContinue ? [...lookupCtx.attachedIds, ...newIds] : lookupCtx.attachedIds
                const newAutoIds = canContinue ? [...lookupCtx.autoIds, ...newIds] : lookupCtx.autoIds

                // Status bubble (UI-only; stripChatDisplayArtifacts removes
                // the 📖 line if an abort strands it in history).
                const lookedUpTitles = newIds
                  .map(id => sNow.documents.find(d => d.id === id)?.title)
                  .filter(Boolean)
                  .join(', ')
                const statusText = canContinue
                  ? `📖 Reading ${lookedUpTitles}…`
                  : '📖 Retrying with the already-available context…'
                s.setMessages(useAppStore.getState().messages.map(m =>
                  m.id === assistantMsgId ? { ...m, content: statusText } : m
                ))

                if (sNow.debugMode) {
                  console.log('[AgenticLookup]', {
                    round: lookupCtx.round,
                    requested: lookup.wantsAll ? '*' : lookup.titles,
                    reason: lookup.reason,
                    attached: newIds,
                    canContinue
                  })
                }

                accumulatedTextRef.current = ''
                const dynamicContext = buildDynamicContext(combinedIds)
                // Loop breaker: when nothing new can be attached (or rounds are
                // exhausted), retry once WITHOUT lookupCtx and tell the model
                // to answer with what it has — a further <lookup> just renders
                // as text instead of looping.
                const loopBreakNote = canContinue
                  ? ''
                  : '\n\n(Note: every chapter that can be provided is already included above. Answer with the available context. Do NOT emit <lookup> again.)'
                const finalUserMessage: LLMMessage = {
                  role: 'user',
                  content: `${dynamicContext}\n\nUSER REQUEST:\n${lookupCtx.promptText}${loopBreakNote}`,
                  images: lookupCtx.images
                }
                const nextMessages = [...lookupCtx.prefixMessages, finalUserMessage]
                previousAttachedIdsRef.current = combinedIds
                void startLLMStreamingRef.current?.(
                  nextMessages,
                  assistantMsgId,
                  originalDocContent,
                  buildAttachmentsLabel(combinedIds, sNow.documents, newAutoIds),
                  Math.ceil(JSON.stringify(nextMessages).length / 4),
                  canContinue
                    ? { ...lookupCtx, attachedIds: combinedIds, autoIds: newAutoIds, round: lookupCtx.round + 1 }
                    : undefined
                )
                return
              }
            }

            s.setStreaming(false)

            let finalChatText: string
            let finalCanvasText = ''
            let finalSelectionReplaceText = ''
            let isSelectionEdit = false
            let isEditMode = false
            let canvasClosed = false

            // Robustly extract the tagged block (tolerates case / attributes /
            // whitespace) and, critically, reports whether the closing tag
            // actually arrived so we can refuse to apply a truncated rewrite.
            // Priority: selection_replace > localized edits > full-doc canvas.
            const selectionBlock = extractTaggedBlock(fullText, 'selection_replace')
            const parsedEdits = parseEditBlocks(fullText)
            const canvasBlock = extractTaggedBlock(fullText, 'canvas')

            if (selectionBlock.found) {
              isSelectionEdit = true
              finalSelectionReplaceText = selectionBlock.inner
              finalChatText = selectionBlock.before.trim()
              if (selectionBlock.after.trim()) {
                finalChatText += '\n\n' + selectionBlock.after.trim()
              }
            } else if (parsedEdits.blocks.length > 0) {
              isEditMode = true
              finalChatText = parsedEdits.before
              if (parsedEdits.after) {
                finalChatText += (finalChatText ? '\n\n' : '') + parsedEdits.after
              }
            } else if (canvasBlock.found) {
              canvasClosed = canvasBlock.closed
              finalCanvasText = canvasBlock.inner
              finalChatText = canvasBlock.before.trim()
              if (canvasBlock.after.trim()) {
                finalChatText += '\n\n' + canvasBlock.after.trim()
              }
            } else {
              finalChatText = fullText
            }

            // Apply localized search/replace edits by rebuilding the full
            // document locally, then reuse the existing diff machinery.
            // Edits whose SEARCH text can't be located are skipped (never
            // destructive) and reported to the user.
            let editDiffedDoc: string | null = null
            let editFailedCount = 0
            if (isEditMode) {
              const placeholderOriginal = preserveImagesWithPlaceholders(originalDocContent)
              const { html: newPlaceholderDoc, failed } = applyEditBlocks(placeholderOriginal, parsedEdits.blocks)
              editFailedCount = failed.length
              if (failed.length > 0) {
                // Surface the unmatched SEARCH text for diagnosis — the usual
                // cause is the model paraphrasing instead of copying verbatim.
                console.warn(
                  `[edit-apply] ${failed.length}/${parsedEdits.blocks.length} edit block(s) failed to match.`,
                  failed.map(f => ({ search: f.search }))
                )
              }
              if (parsedEdits.blocks.length - failed.length > 0) {
                const newDoc = stripBlankParagraphs(restoreImagesFromPlaceholders(newPlaceholderDoc))
                editDiffedDoc = diffHtml(originalDocContent, newDoc)
              }
            }

            // Guard the destructive full-document replacement: if the response
            // was cut off (no closing tag) or abbreviates unchanged regions
            // with placeholders, applying the diff would silently delete
            // content. Skip it, keep the original, and tell the user.
            let canvasIssue: 'truncated' | 'elided' | null = null
            if (!isSelectionEdit && !isEditMode && finalCanvasText.trim()) {
              const candidate = stripBlankParagraphs(restoreImagesFromPlaceholders(finalCanvasText))
              canvasIssue = validateCanvasReplacement(candidate, canvasClosed)
            }

            let warningNote = canvasIssue === 'truncated'
              ? '\n\n⚠️ The response was cut off before the document update finished, so no changes were applied (your document is unchanged). Please retry — for long documents, try editing a smaller selection at a time.'
              : canvasIssue === 'elided'
              ? '\n\n⚠️ The response abbreviated unchanged parts of the document, so applying it would have deleted content. No changes were applied. Please retry — for long documents, try editing a smaller selection at a time.'
              : ''
            if (editFailedCount > 0) {
              warningNote += `\n\n⚠️ ${editFailedCount} suggested change${editFailedCount > 1 ? 's' : ''} could not be located in the current document and ${editFailedCount > 1 ? 'were' : 'was'} skipped. The text to change may have moved or differ from what was matched.`
            }

            const displayChatText = (attachmentsText
              ? `${attachmentsText}\n\n${finalChatText.trim() || 'Document updated successfully.'}`
              : (finalChatText.trim() || 'Document updated successfully.')) + warningNote

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
                const restoredText = stripBlankParagraphs(restoreImagesFromPlaceholders(cleanedText))
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
            } else if (isEditMode) {
              // Apply the locally-rebuilt diff, or leave the document untouched
              // if no edit could be located.
              s.updateActiveDocument({ content: editDiffedDoc ?? originalDocContent })
            } else if (finalCanvasText.trim() && !canvasIssue) {
              const restoredText = stripBlankParagraphs(restoreImagesFromPlaceholders(finalCanvasText))
              const diffed = diffHtml(originalDocContent, restoredText)
              s.updateActiveDocument({ content: diffed })
            } else if (canvasIssue) {
              // Ensure the document is left exactly as it was before streaming.
              s.updateActiveDocument({ content: originalDocContent })
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
  }, [activeEditor, selectedText, preserveImagesWithPlaceholders, restoreImagesFromPlaceholders, forceSave, setSaveStatus, buildDynamicContext])

  // Keep the self-reference current for lookup-loop continuation rounds.
  useEffect(() => {
    startLLMStreamingRef.current = startLLMStreaming
  }, [startLLMStreaming])

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

    // ── Whole-book mode (escalation ladder, spec §6) ──────────────────────
    // Plan + consent happen BEFORE anything enters the chat so 'cancel' has
    // zero side effects. 'once' resets after the send; 'sticky' persists and
    // moves the book into the stable prompt prefix (cache-read pricing on
    // turns 2+), consenting only on its first send.
    const wholeBookMode = s.documents.length > 1 ? s.wholeBookMode : 'off'
    if (s.wholeBookMode === 'once') s.setWholeBookMode('off')

    let wholeBookPlan: {
      mode: 'full' | 'fast' | 'batched'
      sticky: boolean
      docs: typeof s.documents
      batches: (typeof s.documents)[]
      budgetChars: number
    } | null = null

    if (wholeBookMode !== 'off') {
      const docs = s.documents.filter(d =>
        d.id !== s.activeDocumentId && d.contentLoaded !== false && d.content.length > 0
      )
      const totalChars = docs.reduce((sum, d) => sum + d.content.length, 0)
      const budgetChars = WHOLE_BOOK_CONTEXT_CHARS[s.activeProvider] ?? 300_000
      const approxTokensK = Math.max(1, Math.round(totalChars / 4000))
      // Rung 1 confirms above ~50k tokens; Rung 2 (multi-call) always confirms.
      const CONFIRM_THRESHOLD_CHARS = 200_000
      // Sticky only changes the layout when the book fits in one call —
      // re-running a batched pass every turn would multiply cost, so an
      // over-budget book behaves like 'once' even when sticky.
      const sticky = wholeBookMode === 'sticky' && totalChars <= budgetChars

      if (totalChars <= budgetChars) {
        let mode: 'full' | 'fast' = 'full'
        const needsConsent = totalChars > CONFIRM_THRESHOLD_CHARS &&
          !(sticky && stickyConsentGivenRef.current)
        if (needsConsent) {
          const choice = await requestWholeBookConsent({ approxTokensK, chapterCount: docs.length })
          if (choice === 'cancel') return
          mode = choice === 'proceed' ? 'full' : 'fast'
          if (sticky && choice === 'proceed') stickyConsentGivenRef.current = true
        }
        wholeBookPlan = { mode, sticky, docs, batches: [], budgetChars }
      } else {
        const batches = packChaptersIntoBatches(docs, budgetChars)
        const choice = await requestWholeBookConsent({
          approxTokensK,
          chapterCount: docs.length,
          batchCount: batches.length + 1
        })
        if (choice === 'cancel') return
        wholeBookPlan = { mode: choice === 'proceed' ? 'batched' : 'fast', sticky: false, docs, batches, budgetChars }
      }
    } else {
      stickyConsentGivenRef.current = false
    }

    const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
    const originalDocContent = activeDoc?.content || ''

    s.createVersionSnapshot(`Auto-save before: "${promptText.substring(0, 30)}${promptText.length > 30 ? '...' : ''}"`)
    
    if (!customPrompt) {
      setChatInput('')
      if (chatInputRef.current) {
        chatInputRef.current.innerHTML = ''
      }
    }

    // Layer 1 auto-selection: pinned chapters always attach; the scorer adds
    // relevant ones (title mentions, adjacency, keyword overlap, continuity)
    // under the context budget. Blocked chapters never auto-attach.
    const selection = selectReferenceChapters({
      promptText,
      recentHistory: s.messages.filter(m => m.id !== 'welcome').map(m => m.content),
      documents: s.documents,
      activeDocumentId: s.activeDocumentId,
      pinnedIds: s.pinnedReferenceIds,
      blockedIds: s.blockedReferenceIds,
      previousAttachedIds: previousAttachedIdsRef.current
    })
    const finalReferenceIds = selection.attachedIds
    previousAttachedIdsRef.current = finalReferenceIds

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

    const systemPrompt = buildSystemPrompt()

    // Prompt layout: [stable system] + [stable, windowed history] + [volatile
    // document context merged into the final user message]. The stable prefix
    // is what makes provider prompt caching effective turn over turn.
    const historyMessages: LLMMessage[] = trimHistoryForContext(
      s.messages
        .filter(m => m.id !== 'welcome')
        .map(m => ({
          role: m.role,
          content: stripChatDisplayArtifacts(m.content),
          images: m.images
        })),
      { maxChars: MAX_HISTORY_CHARS, keepImagesInLast: KEEP_IMAGES_IN_LAST_MESSAGES }
    )
    if (historyMessages.length > 0) {
      historyMessages[historyMessages.length - 1].cacheHint = true
    }

    // Non-blocking: this turn uses existing summaries; refreshed ones (queued
    // behind the in-flight stream) serve the next turn.
    enqueueStaleSummaryRefreshes()

    // Execute the whole-book plan decided (and consented) before the message
    // entered the chat.
    let attachedIds = finalReferenceIds
    let autoIds = selection.autoIds
    let dynamicContext: string
    let attachmentsText: string
    let allowLookup = true
    // Sticky whole-book: the (unchanging) book text moves into the stable
    // prompt prefix — right after the system prompt, before history — with
    // its own cache breakpoint, so turns 2+ read it at cache prices. The
    // volatile tail (index + active doc) stays in the final user message.
    let bookPrefixMessages: LLMMessage[] = []

    if (wholeBookPlan) {
      const { mode, sticky, docs, batches, budgetChars } = wholeBookPlan
      allowLookup = false // everything available is already being provided
      autoIds = []

      if (mode === 'full' && sticky) {
        const bookText = docs
          .map(d => `--- DOCUMENT: ${d.title} ---\n${htmlToPlainText(d.content)}`)
          .join('\n\n')
        bookPrefixMessages = [
          {
            role: 'user',
            content: `REFERENCED BOOK CONTENT (read-only; every chapter except the active document — use it for details and consistency):\n\n${bookText}`,
            cacheHint: true
          },
          // Providers require alternating roles; the ack keeps history's
          // leading user turn valid after the injected user message.
          { role: 'assistant', content: 'Understood. I have read the full book content and will use it as reference.' }
        ]
        attachedIds = docs.map(d => d.id)
        dynamicContext = buildDynamicContext([])
        attachmentsText = `[Attached Context: Whole book (${docs.length} chapters, sticky)]`
      } else if (mode === 'full') {
        // Rung 1: attach every chapter, single call.
        attachedIds = docs.map(d => d.id)
        dynamicContext = buildDynamicContext(attachedIds, { perDocChars: Number.MAX_SAFE_INTEGER })
        attachmentsText = `[Attached Context: Whole book (${docs.length} chapters)]`
      } else if (mode === 'batched') {
        // Rung 2: map-reduce over book-order batches, then answer from notes.
        const notes = await runWholeBookBatches(promptText, batches, assistantMsgId, budgetChars)
        if (notes === null) {
          s.setStreaming(false)
          s.setMessages(useAppStore.getState().messages.map(m =>
            m.id === assistantMsgId
              ? { ...m, content: '⚠️ Whole-book processing was cancelled or failed before completion. No answer was generated.' }
              : m
          ))
          forceSave()
          return
        }
        attachedIds = []
        dynamicContext = buildDynamicContext([], { notesBlock: notes })
        attachmentsText = `[Attached Context: Whole book (${docs.length} chapters, read in ${batches.length} batches)]`
      } else {
        // Rung 0 fast mode: structure + summaries, no full text.
        attachedIds = []
        dynamicContext = buildDynamicContext([], { includeWholeBookDigest: true })
        attachmentsText = '[Attached Context: Whole-book digest (structure + summaries)]'
      }
      previousAttachedIdsRef.current = attachedIds
    } else {
      dynamicContext = buildDynamicContext(attachedIds)
      attachmentsText = buildAttachmentsLabel(attachedIds, s.documents, autoIds)
    }

    const finalUserMessage: LLMMessage = {
      role: 'user',
      content: `${dynamicContext}\n\nUSER REQUEST:\n${promptText}`,
      images: userMsg.images
    }

    const apiMessages = [systemPrompt, ...bookPrefixMessages, ...historyMessages, finalUserMessage]
    const estimatedInputTokens = Math.ceil(JSON.stringify(apiMessages).length / 4)

    // Arm the agentic lookup loop for multi-chapter books (when enabled).
    // Pointless in whole-book mode: everything is already provided.
    const lookupCtx: LookupLoopContext | undefined =
      allowLookup && s.agenticLookupEnabled && s.documents.length > 1
        ? {
            promptText,
            images: userMsg.images,
            prefixMessages: [systemPrompt, ...historyMessages],
            attachedIds,
            autoIds,
            round: 0
          }
        : undefined

    await startLLMStreaming(apiMessages, assistantMsgId, originalDocContent, attachmentsText, estimatedInputTokens, lookupCtx)
  }, [chatInput, uploadedImages, layoutMode, setIsChatExpanded, setUploadedImages, buildSystemPrompt, buildDynamicContext, startLLMStreaming, runWholeBookBatches, forceSave, requestWholeBookConsent])

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

    const selection = selectReferenceChapters({
      promptText: trimmed,
      recentHistory: truncatedMessages.slice(0, -1).filter(m => m.id !== 'welcome').map(m => m.content),
      documents: s.documents,
      activeDocumentId: s.activeDocumentId,
      pinnedIds: s.pinnedReferenceIds,
      blockedIds: s.blockedReferenceIds,
      previousAttachedIds: previousAttachedIdsRef.current
    })
    const finalReferenceIds = selection.attachedIds
    previousAttachedIdsRef.current = finalReferenceIds

    const systemPrompt = buildSystemPrompt()
    const dynamicContext = buildDynamicContext(finalReferenceIds)

    // Same prompt layout as handleSendMessage: stable prefix first, volatile
    // document context merged into the final (edited) user message.
    const editedMsg = truncatedMessages[truncatedMessages.length - 1]
    const historyMessages: LLMMessage[] = trimHistoryForContext(
      truncatedMessages
        .slice(0, -1)
        .filter(m => m.id !== 'welcome')
        .map(m => ({
          role: m.role,
          content: stripChatDisplayArtifacts(m.content),
          images: m.images
        })),
      { maxChars: MAX_HISTORY_CHARS, keepImagesInLast: KEEP_IMAGES_IN_LAST_MESSAGES }
    )
    if (historyMessages.length > 0) {
      historyMessages[historyMessages.length - 1].cacheHint = true
    }

    const finalUserMessage: LLMMessage = {
      role: 'user',
      content: `${dynamicContext}\n\nUSER REQUEST:\n${trimmed}`,
      images: editedMsg?.images
    }

    const apiMessages = [systemPrompt, ...historyMessages, finalUserMessage]
    const estimatedInputTokens = Math.ceil(JSON.stringify(apiMessages).length / 4)

    const attachmentsText = buildAttachmentsLabel(finalReferenceIds, s.documents, selection.autoIds)

    const lookupCtx: LookupLoopContext | undefined =
      s.agenticLookupEnabled && s.documents.length > 1
        ? {
            promptText: trimmed,
            images: editedMsg?.images,
            prefixMessages: [systemPrompt, ...historyMessages],
            attachedIds: finalReferenceIds,
            autoIds: selection.autoIds,
            round: 0
          }
        : undefined

    await startLLMStreaming(apiMessages, assistantMsgId, originalDocContent, attachmentsText, estimatedInputTokens, lookupCtx)
  }, [layoutMode, setIsChatExpanded, buildSystemPrompt, buildDynamicContext, startLLMStreaming])

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
    handleStopGeneration,
    wholeBookConsent,
    resolveWholeBookConsent
  }
}
