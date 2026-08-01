import { useState, useRef, useCallback, useEffect } from 'react'
import { Editor } from '@tiptap/react'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import { useAppStore } from '../store/useAppStore'
import { streamLLM, type LLMMessage } from '../services/llm'
import { getTimestampId, stripIncompleteEndTag, stripBlankParagraphs, validateCanvasReplacement, applyEditBlocks, parseLookupRequest, parseAssistantResponse, looksLikeUnfulfilledDocumentUpdate, trimIncompleteHtmlTail } from '../utils/text'
import { diffHtml } from '../utils/diff'
import { trimHistoryForContext, stripChatDisplayArtifacts, buildAttachmentsLabel, resolveLookupTitles } from '../utils/llmContext'
import { replaceImagesWithPlaceholders, restoreImagePlaceholders, reinsertMissingImages, type ImagePlaceholderEntry } from '../utils/imagePreservation'
import { selectReferenceChapters } from '../utils/contextSelection'
import { buildChatSystemPrompt } from '../utils/systemPrompt'
import { enqueueStaleSummaryRefreshes } from '../services/chapterSummaries'
import type { LookupLoopContext, HistorySourceMessage } from './chat/types'
import { MAX_NO_ACTION_RETRIES, NO_ACTION_RETRY_INSTRUCTION, splitStreamingResponse, buildCompletionWarnings } from './chat/streamHandlers'
import { buildDynamicContext as assembleDynamicContext, type DynamicContextOptions } from './chat/dynamicContext'
import {
  planWholeBook as planWholeBookFlow,
  runWholeBookBatches as runWholeBookBatchesFlow,
  buildStickyBookPrefix,
  type WholeBookDoc,
  type WholeBookPlan,
  type WholeBookConsentRequest,
  type WholeBookConsentChoice
} from './chat/wholeBook'

// Consent types are re-exported so consumers (ChatPanel) keep importing them
// from the hook module after the split into hooks/chat/.
export type { WholeBookConsentRequest, WholeBookConsentChoice }

// Approximate character budget for chat history sent to the LLM. History is
// windowed (most recent first) so long sessions don't grow the prompt without
// bound; the active document is always sent in full separately.
const MAX_HISTORY_CHARS = 80_000
// Base64 images are only re-sent for the most recent messages — older ones
// dominate token cost while rarely being referenced again.
const KEEP_IMAGES_IN_LAST_MESSAGES = 4
// Agentic lookup loop guards: how many <lookup> continuation rounds a single
// user request may trigger, and how many chapters each round may attach.
const MAX_LOOKUP_ROUNDS = 2
const MAX_LOOKUP_CHAPTERS_PER_ROUND = 3

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
  const imagePlaceholdersRef = useRef<ImagePlaceholderEntry[]>([])
  // Chapters attached on the previous turn — feeds the scorer's continuity
  // signal so a chapter under discussion isn't dropped mid-conversation.
  const previousAttachedIdsRef = useRef<string[]>([])
  // Self-reference for the lookup loop: onDone re-invokes the streaming
  // engine, which can't reference its own useCallback binding directly.
  const startLLMStreamingRef = useRef<
    ((apiMessages: LLMMessage[], assistantMsgId: string, originalDocContent: string, attachmentsText: string, estimatedInputTokens: number, lookupCtx?: LookupLoopContext, noActionRetriesLeft?: number) => Promise<void>) | null
  >(null)
  // Throttles the live selection-edit preview: re-parsing + replacing the whole
  // (growing) replacement on every streamed token is O(n²) and re-renders
  // ProseMirror per token, which stutters once the output passes a few
  // paragraphs. onDone always applies the final result, so coalescing the
  // intermediate previews is safe.
  const lastSelectionPreviewRef = useRef(0)
  // Live <canvas> preview: streamed document text is rendered into the editor
  // as it arrives (measured: ~17s to first token, then ~70s of generation for
  // a chapter rewrite — without this the user watches a frozen document for
  // the whole minute). Throttled harder than the selection preview because
  // each tick re-parses the WHOLE growing document, not a small slice.
  const CANVAS_PREVIEW_THROTTLE_MS = 250
  const lastCanvasPreviewRef = useRef(0)
  // True once a live preview has written to the editor: every terminal path
  // (done / truncated / error / abort / retry) MUST then converge the editor
  // explicitly. The store may still hold the pre-stream HTML, in which case
  // Editor.tsx's content-prop effect sees no change and would leave the
  // half-streamed draft on screen.
  const canvasPreviewActiveRef = useRef(false)

  /** Force the editor back to `html` after a live preview, without polluting undo. */
  const settleCanvasPreview = useCallback((html: string) => {
    if (!canvasPreviewActiveRef.current) return
    canvasPreviewActiveRef.current = false
    lastCanvasPreviewRef.current = 0
    if (activeEditor && activeEditor.getHTML() !== html) {
      activeEditor.chain().setMeta('addToHistory', false).setContent(html, { emitUpdate: false }).run()
    }
  }, [activeEditor])

  // Image preservation during LLM streaming: swap base64 <img> tags for
  // small tokens before sending, restore them (tolerantly) on the way back.
  // Pure logic lives in utils/imagePreservation; the registry is per-request.
  const preserveImagesWithPlaceholders = useCallback((html: string) => {
    return replaceImagesWithPlaceholders(html, imagePlaceholdersRef.current)
  }, [])

  const restoreImagesFromPlaceholders = useCallback((html: string) => {
    return restoreImagePlaceholders(html, imagePlaceholdersRef.current)
  }, [])

  // Build the system prompt: a static instruction block (kept stable so
  // provider-side prompt caching works) plus the user's selected system
  // prompt preset, which only changes when they pick a different preset.
  // Layering (protocol → lookup → preset → format reminder) lives in
  // utils/systemPrompt so it can be tested.
  const buildSystemPrompt = useCallback((): LLMMessage => {
    const s = useAppStore.getState()
    const preset = s.customSystemPrompts.find(p => p.id === s.activeSystemPromptId)
    return {
      role: 'system',
      content: buildChatSystemPrompt({
        customInstructions: preset?.content,
        includeChapterLookup: s.agenticLookupEnabled && s.documents.length > 1
      })
    }
  }, [])

  // Volatile document context (reference docs + active doc). Assembly is pure
  // and lives in chat/dynamicContext (see there for the prompt-layout
  // rationale); this wrapper binds the current selection and the per-request
  // image-placeholder registry.
  const buildDynamicContext = useCallback((
    finalReferenceIds: string[],
    opts?: DynamicContextOptions
  ): string => {
    return assembleDynamicContext(finalReferenceIds, selectedText, preserveImagesWithPlaceholders, opts)
  }, [selectedText, preserveImagesWithPlaceholders])

  // Whole-book Rung 2 batched read (implementation in chat/wholeBook). The
  // hook owns the abort controller so Stop cancels the batch loop exactly
  // like it cancels a stream.
  const runWholeBookBatches = useCallback(async (
    promptText: string,
    batches: WholeBookDoc[][],
    assistantMsgId: string,
    perBatchChars: number
  ): Promise<string | null> => {
    if (abortControllerRef.current) abortControllerRef.current.abort()
    abortControllerRef.current = new AbortController()
    return runWholeBookBatchesFlow(promptText, batches, assistantMsgId, perBatchChars, abortControllerRef.current.signal)
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
    lookupCtx?: LookupLoopContext,
    noActionRetriesLeft: number = MAX_NO_ACTION_RETRIES
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
        { ...s.providerConfigs[s.activeProvider], provider: s.activeProvider, debug: s.debugMode, signal, conversationId: s.activeBookId },
        {
          onChunk: (chunk: string) => {
            accumulatedTextRef.current += chunk
            const raw = accumulatedTextRef.current

            // Incremental tag split (pure; chat/streamHandlers): routes
            // document markup away from the chat bubble as it streams.
            const { chatText, canvasText, selectionReplaceText, isSelectionEdit } = splitStreamingResponse(raw)

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
              // Stream the document into the editor. The store is deliberately
              // NOT updated here: it would churn persistence every tick and
              // fight Editor.tsx's content-prop sync. onDone/onError own the
              // final state (see settleCanvasPreview).
              const now = Date.now()
              if (activeEditor && now - lastCanvasPreviewRef.current >= CANVAS_PREVIEW_THROTTLE_MS) {
                lastCanvasPreviewRef.current = now
                canvasPreviewActiveRef.current = true
                const partial = restoreImagesFromPlaceholders(trimIncompleteHtmlTail(canvasText))
                activeEditor.chain()
                  .setMeta('addToHistory', false)
                  .setContent(partial, { emitUpdate: false })
                  .run()
              }
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
                // Async continuation: requested chapters may exist only as
                // server metadata (lazy loading) — fetch their content first,
                // THIS is the "Layer 2 can fetch them later" the selector's
                // degrade path relies on. ensureDocumentContents never throws.
                void (async () => {
                  const sPre = useAppStore.getState()
                  const requestedIds = lookup.wantsAll
                    ? sPre.documents.filter(d => d.id !== sPre.activeDocumentId).map(d => d.id)
                    : resolveLookupTitles(lookup.titles, sPre.documents, sPre.activeDocumentId)
                  await sPre.ensureDocumentContents(requestedIds)
                  const sNow = useAppStore.getState()
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
                  settleCanvasPreview(originalDocContent)
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
                })()
                return
              }
            }

            // Classify the completed response (pure, tested in utils/text).
            // Priority: selection_replace > localized edits > full-doc canvas.
            const parsed = parseAssistantResponse(fullText)
            const finalChatText = parsed.chatText

            // Tag compliance is probabilistic (see
            // looksLikeUnfulfilledDocumentUpdate): the model sometimes answers
            // a write request with a one-line "done" and no tags, which used to
            // surface as a success message over an unchanged document. Retry
            // the turn once with the failed reply quoted back, then give up
            // loudly rather than silently.
            if (
              noActionRetriesLeft > 0 &&
              parsed.kind === 'chat' &&
              looksLikeUnfulfilledDocumentUpdate(fullText)
            ) {
              settleCanvasPreview(originalDocContent)
              s.setMessages(useAppStore.getState().messages.map(m =>
                m.id === assistantMsgId
                  ? { ...m, content: `🔁 That reply contained no document update — retrying (${MAX_NO_ACTION_RETRIES - noActionRetriesLeft + 1}/${MAX_NO_ACTION_RETRIES})…` }
                  : m
              ))
              accumulatedTextRef.current = ''
              const retryMessages: LLMMessage[] = [
                ...apiMessages,
                { role: 'assistant', content: fullText },
                { role: 'user', content: NO_ACTION_RETRY_INSTRUCTION }
              ]
              void startLLMStreamingRef.current?.(
                retryMessages,
                assistantMsgId,
                originalDocContent,
                attachmentsText,
                Math.ceil(JSON.stringify(retryMessages).length / 4),
                undefined,
                noActionRetriesLeft - 1
              )
              return
            }

            s.setStreaming(false)

            // Apply localized search/replace edits by rebuilding the full
            // document locally, then reuse the existing diff machinery.
            // Edits whose SEARCH text can't be located are skipped (never
            // destructive) and reported to the user.
            let editDiffedDoc: string | null = null
            let editFailedCount = 0
            if (parsed.kind === 'edits') {
              const placeholderOriginal = preserveImagesWithPlaceholders(originalDocContent)
              const { html: newPlaceholderDoc, failed } = applyEditBlocks(placeholderOriginal, parsed.editBlocks)
              editFailedCount = failed.length
              if (failed.length > 0) {
                // Surface the unmatched SEARCH text for diagnosis — the usual
                // cause is the model paraphrasing instead of copying verbatim.
                console.warn(
                  `[edit-apply] ${failed.length}/${parsed.editBlocks.length} edit block(s) failed to match.`,
                  failed.map(f => ({ search: f.search }))
                )
              }
              if (parsed.editBlocks.length - failed.length > 0) {
                const newDoc = stripBlankParagraphs(restoreImagesFromPlaceholders(newPlaceholderDoc))
                editDiffedDoc = diffHtml(originalDocContent, newDoc)
              }
            }

            // Guard the destructive full-document replacement: if the response
            // was cut off (no closing tag) or abbreviates unchanged regions
            // with placeholders, applying the diff would silently delete
            // content. Skip it, keep the original, and tell the user.
            // Valid replacements then pass the image safety net: any image the
            // rewrite dropped (the model lost its placeholder token) is
            // re-inserted near its original position instead of vanishing.
            let canvasIssue: 'truncated' | 'elided' | null = null
            let canvasDoc: string | null = null
            let reinsertedImages = 0
            if (parsed.kind === 'canvas' && parsed.canvasText.trim()) {
              const candidate = stripBlankParagraphs(restoreImagesFromPlaceholders(parsed.canvasText))
              canvasIssue = validateCanvasReplacement(candidate, parsed.canvasClosed)
              if (!canvasIssue) {
                const result = reinsertMissingImages(candidate, originalDocContent)
                canvasDoc = result.html
                reinsertedImages = result.reinserted
              }
            }

            // Message text lives in chat/streamHandlers; only the exhausted-
            // retries condition needs hook-local state to compute.
            const warningNote = buildCompletionWarnings({
              canvasIssue,
              editFailedCount,
              exhaustedNoActionRetries:
                noActionRetriesLeft === 0 &&
                parsed.kind === 'chat' &&
                looksLikeUnfulfilledDocumentUpdate(fullText),
              reinsertedImages
            })

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

            if (parsed.kind === 'selection') {
              const cleanedText = stripIncompleteEndTag(parsed.selectionText)
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
            } else if (parsed.kind === 'edits') {
              // Apply the locally-rebuilt diff, or leave the document untouched
              // if no edit could be located.
              s.updateActiveDocument({ content: editDiffedDoc ?? originalDocContent })
            } else if (parsed.kind === 'canvas' && canvasDoc !== null) {
              const diffed = diffHtml(originalDocContent, canvasDoc)
              s.updateActiveDocument({ content: diffed })
            } else if (canvasIssue) {
              // Ensure the document is left exactly as it was before streaming.
              s.updateActiveDocument({ content: originalDocContent })
            }

            // Converge the editor with whatever the store ended up holding.
            // Required after a live preview: on the paths that keep the
            // original HTML (truncated, elided, tag-free reply) the store value
            // never changes, so nothing else would clear the streamed draft.
            const settledState = useAppStore.getState()
            settleCanvasPreview(
              settledState.documents.find(d => d.id === settledState.activeDocumentId)?.content ?? originalDocContent
            )
            forceSave()
          },
          onError: (err: Error) => {
            s.setStreaming(false)
            
            const isAbort = err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('cancel')
            if (isAbort) {
              // Stopping mid-stream discards the partial draft — the store was
              // never updated, so the editor must be rolled back explicitly.
              settleCanvasPreview(originalDocContent)
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

            settleCanvasPreview(originalDocContent)
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
  }, [activeEditor, selectedText, preserveImagesWithPlaceholders, restoreImagesFromPlaceholders, forceSave, setSaveStatus, buildDynamicContext, settleCanvasPreview])

  // Keep the self-reference current for lookup-loop continuation rounds.
  useEffect(() => {
    startLLMStreamingRef.current = startLLMStreaming
  }, [startLLMStreaming])

  // Whole-book planning (escalation ladder, spec §6 — implementation in
  // chat/wholeBook): plan + consent happen BEFORE anything enters the chat so
  // 'cancelled' has zero side effects.
  const planWholeBook = useCallback((): Promise<WholeBookPlan | null | 'cancelled'> => {
    return planWholeBookFlow(requestWholeBookConsent, stickyConsentGivenRef)
  }, [requestWholeBookConsent])

  // ── Shared request assembly ─────────────────────────────────────────────
  // Single source of truth for both send and resubmit: Layer 1 selection,
  // prompt layout ([stable system] + [optional sticky book prefix] +
  // [windowed history] + [volatile context in the final user message]),
  // whole-book plan execution, and the lookup-loop arming. Returns null when
  // a batched whole-book pass aborted/failed (already reported to the user).
  const assembleChatRequest = useCallback(async (opts: {
    promptText: string
    images?: string[]
    /** Messages that form the history window (excluding the new turn). */
    historySource: HistorySourceMessage[]
    assistantMsgId: string
    originalDocContent: string
    wholeBookPlan: WholeBookPlan | null
  }): Promise<{
    apiMessages: LLMMessage[]
    attachmentsText: string
    estimatedInputTokens: number
    lookupCtx?: LookupLoopContext
  } | null> => {
    const { promptText, images, historySource, assistantMsgId, wholeBookPlan } = opts

    // Pinned chapters are an explicit user choice — make sure their content
    // is loaded (server books lazy-load metadata-only chapters) BEFORE Layer 1
    // selection, otherwise attachable() silently drops them and the pin is a
    // no-op. Usually instant: pinning already triggered the eager load.
    const pinnedAtSend = useAppStore.getState().pinnedReferenceIds
    if (pinnedAtSend.length > 0) {
      await useAppStore.getState().ensureDocumentContents(pinnedAtSend)
    }
    const s = useAppStore.getState()

    // Layer 1 auto-selection: pinned chapters always attach; the scorer adds
    // relevant ones (title mentions, adjacency, keyword overlap, continuity)
    // under the context budget. Blocked chapters never auto-attach.
    const selection = selectReferenceChapters({
      promptText,
      recentHistory: historySource.filter(m => m.id !== 'welcome').map(m => m.content),
      documents: s.documents,
      activeDocumentId: s.activeDocumentId,
      pinnedIds: s.pinnedReferenceIds,
      blockedIds: s.blockedReferenceIds,
      previousAttachedIds: previousAttachedIdsRef.current
    })
    previousAttachedIdsRef.current = selection.attachedIds

    const systemPrompt = buildSystemPrompt()

    // Prompt layout: the stable prefix is what makes provider prompt caching
    // effective turn over turn.
    const historyMessages: LLMMessage[] = trimHistoryForContext(
      historySource
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
    let attachedIds = selection.attachedIds
    let autoIds = selection.autoIds
    let dynamicContext: string
    let attachmentsText: string
    let allowLookup = true
    // Sticky whole-book: the book text joins the stable prompt prefix (see
    // buildStickyBookPrefix in chat/wholeBook for the caching layout).
    let bookPrefixMessages: LLMMessage[] = []

    if (wholeBookPlan) {
      const { mode, sticky, docs, batches, budgetChars } = wholeBookPlan
      allowLookup = false // everything available is already being provided
      autoIds = []

      if (mode === 'full' && sticky) {
        bookPrefixMessages = buildStickyBookPrefix(docs)
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
          return null
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
      images
    }

    const apiMessages = [systemPrompt, ...bookPrefixMessages, ...historyMessages, finalUserMessage]

    // Arm the agentic lookup loop for multi-chapter books (when enabled).
    // Pointless in whole-book mode: everything is already provided.
    const lookupCtx: LookupLoopContext | undefined =
      allowLookup && s.agenticLookupEnabled && s.documents.length > 1
        ? {
            promptText,
            images,
            prefixMessages: [systemPrompt, ...historyMessages],
            attachedIds,
            autoIds,
            round: 0
          }
        : undefined

    return {
      apiMessages,
      attachmentsText,
      estimatedInputTokens: Math.ceil(JSON.stringify(apiMessages).length / 4),
      lookupCtx
    }
  }, [buildSystemPrompt, buildDynamicContext, runWholeBookBatches, forceSave])

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

    const wholeBookPlan = await planWholeBook()
    if (wholeBookPlan === 'cancelled') return

    const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
    const originalDocContent = activeDoc?.content || ''

    s.createVersionSnapshot(`Auto-save before: "${promptText.substring(0, 30)}${promptText.length > 30 ? '...' : ''}"`)

    if (!customPrompt) {
      setChatInput('')
      if (chatInputRef.current) {
        chatInputRef.current.innerHTML = ''
      }
    }

    const images = uploadedImages.length > 0 ? uploadedImages : undefined
    const userMsg = {
      id: getTimestampId('user'),
      role: 'user' as const,
      content: promptText,
      images,
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    }
    s.addMessage(userMsg)
    setUploadedImages([])

    const assistantMsgId = getTimestampId('assistant')
    s.addMessage({
      id: assistantMsgId,
      role: 'assistant' as const,
      content: 'Thinking...',
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    })
    s.setStreaming(true)

    accumulatedTextRef.current = ''

    const request = await assembleChatRequest({
      promptText,
      images,
      // History = the conversation BEFORE this turn (s was captured pre-add).
      historySource: s.messages,
      assistantMsgId,
      originalDocContent,
      wholeBookPlan
    })
    if (!request) return

    await startLLMStreaming(request.apiMessages, assistantMsgId, originalDocContent, request.attachmentsText, request.estimatedInputTokens, request.lookupCtx)
  }, [chatInput, uploadedImages, layoutMode, setIsChatExpanded, setUploadedImages, planWholeBook, assembleChatRequest, startLLMStreaming])

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

    // Resubmit honors whole-book mode the same way a fresh send does.
    const wholeBookPlan = await planWholeBook()
    if (wholeBookPlan === 'cancelled') return

    const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
    const originalDocContent = activeDoc?.content || ''
    s.createVersionSnapshot(`Auto-save before edit: "${trimmed.substring(0, 30)}${trimmed.length > 30 ? '...' : ''}"`)

    const assistantMsgId = getTimestampId('assistant')
    s.setMessages([...truncatedMessages, {
      id: assistantMsgId,
      role: 'assistant' as const,
      content: 'Thinking...',
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    }])
    s.setStreaming(true)

    accumulatedTextRef.current = ''

    const editedMsg = truncatedMessages[truncatedMessages.length - 1]
    const request = await assembleChatRequest({
      promptText: trimmed,
      images: editedMsg?.images,
      // History = everything before the edited (resubmitted) message.
      historySource: truncatedMessages.slice(0, -1),
      assistantMsgId,
      originalDocContent,
      wholeBookPlan
    })
    if (!request) return

    await startLLMStreaming(request.apiMessages, assistantMsgId, originalDocContent, request.attachmentsText, request.estimatedInputTokens, request.lookupCtx)
  }, [layoutMode, setIsChatExpanded, planWholeBook, assembleChatRequest, startLLMStreaming])

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
