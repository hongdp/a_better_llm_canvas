import { useState, useRef, useCallback, useEffect } from 'react'
import { Editor } from '@tiptap/react'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import { useAppStore } from '../store/useAppStore'
import { streamLLM, type LLMMessage } from '../services/llm'
import { findResumableJob, resumeRemoteGeneration, abortRemoteGeneration, clearPersistedJob as clearPersistedGenerationJob } from '../services/remoteGeneration'
import type { StreamCallbacks } from '../types/llm'
import type { AppState } from '../store/types'
import { getTimestampId, stripIncompleteEndTag, stripBlankParagraphs, validateCanvasReplacement, applyEditBlocks, parseAssistantResponse, detectFailedDocumentUpdate, trimIncompleteHtmlTail } from '../utils/text'
import { diffHtml } from '../utils/diff'
import { trimHistoryForContext, stripChatDisplayArtifacts, buildAttachmentsLabel } from '../utils/llmContext'
import { replaceImagesWithPlaceholders, restoreImagePlaceholders, reinsertMissingImages, type ImagePlaceholderEntry } from '../utils/imagePreservation'
import { selectReferenceChapters } from '../utils/contextSelection'
import { buildChatSystemPrompt } from '../utils/systemPrompt'
import { applyToolCallDelta, finishToolCalls, partialStringArgument, type ToolCallAccumulator } from '../utils/toolCallStream'
import { toolsForTurn, toOpenAITools, toolCallToParsedResponse } from '../utils/documentTools'
import { resolveDocumentProtocol } from '../utils/protocolChoice'
import {
  resolveContextWindowTokens,
  estimateTokens,
  historyBudgetChars,
  cjkRatioOf
} from '../utils/contextWindow'
import { enqueueStaleSummaryRefreshes } from '../services/chapterSummaries'
import type { HistorySourceMessage, LedgerConsentRequest, LedgerConsentChoice } from './chat/types'
import { ASSISTANT_PLACEHOLDER, REASONING_TAIL_CHARS, REASONING_PAINT_MS, MAX_NO_ACTION_RETRIES, clampSelectionRange, relocateResumedSelection, NO_ACTION_RETRY_INSTRUCTION, splitStreamingResponse, buildCompletionWarnings } from './chat/streamHandlers'
import { buildLedgerMessages, buildVolatileTail, buildInlineReferenceBlock, type DynamicContextOptions } from './chat/dynamicContext'
import {
  EMPTY_LEDGER,
  hashContent,
  planLedgerTurn,
  planKeepingRemoved,
  orderAdmissionsByStability,
  type ContextLedger,
  type LedgerPlan
} from '../utils/contextLedger'
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

// Per-chapter cap in the ledger. Mirrors the reference-doc cap the renderer
// applies, so the planner's cost arithmetic matches the bytes actually sent.
const MAX_LEDGER_DOC_CHARS = 20_000
// A rejoined stream that produces nothing within this window is treated as
// dead (expired job, restarted server) rather than left spinning.
const REJOIN_FIRST_EVENT_TIMEOUT_MS = 20_000

/**
 * Everything one streamed response needs in order to render itself: the
 * request that produced it (for the no-action retry), the bubble it writes
 * to, the document it may rewrite, and the loop guards.
 */
interface StreamRenderContext {
  apiMessages: LLMMessage[]
  assistantMsgId: string
  originalDocContent: string
  attachmentsText: string
  estimatedInputTokens: number
  noActionRetriesLeft: number
  /**
   * False for readers that cannot re-issue the request (the rejoin path):
   * neither the corrective retry nor its "gave up" warning applies there.
   */
  noActionRetryArmed?: boolean
}

/**
 * Resolves once the store satisfies `predicate`, or false once `timeoutMs`
 * passes. Used by the rejoin path: on a cold reload the chat history is only
 * restored when the background server sync completes.
 */
function waitForStore(predicate: (state: AppState) => boolean, timeoutMs = 15_000): Promise<boolean> {
  if (predicate(useAppStore.getState())) return Promise.resolve(true)
  return new Promise<boolean>(resolve => {
    let unsubscribe: (() => void) | null = null
    const timer = setTimeout(() => {
      unsubscribe?.()
      resolve(false)
    }, timeoutMs)
    unsubscribe = useAppStore.subscribe(state => {
      if (!predicate(state)) return
      clearTimeout(timer)
      unsubscribe?.()
      resolve(true)
    })
  })
}

const waitForMessage = (messageId: string, timeoutMs = 15_000) =>
  waitForStore(state => state.messages.some(m => m.id === messageId), timeoutMs)

/**
 * A turn whose page died before the model answered leaves its bubble on the
 * placeholder forever: the rejoin only revives bubbles whose job still exists,
 * and every other path that clears it died with the tab. Rewrite them once,
 * on load, so a dead turn cannot pass for one in progress.
 */
async function markInterruptedPlaceholders(): Promise<void> {
  // The history arrives with the server sync, typically after this runs.
  await waitForStore(state => state.messages.length > 0, 15_000)
  const s = useAppStore.getState()
  const staleIds = new Set(
    s.messages.filter(m => m.role === 'assistant' && m.content === ASSISTANT_PLACEHOLDER).map(m => m.id)
  )
  if (staleIds.size === 0) return
  s.setMessages(s.messages.map(m =>
    staleIds.has(m.id)
      ? { ...m, content: '⚠️ Interrupted before the model replied (the page reloaded). Send again to retry.' }
      : m
  ))
}

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

  const [ledgerConsent, setLedgerConsent] = useState<LedgerConsentRequest | null>(null)
  const ledgerConsentResolveRef = useRef<((choice: LedgerConsentChoice) => void) | null>(null)

  const requestLedgerConsent = useCallback((req: LedgerConsentRequest): Promise<LedgerConsentChoice> => {
    setLedgerConsent(req)
    return new Promise<LedgerConsentChoice>(resolve => {
      ledgerConsentResolveRef.current = resolve
    })
  }, [])

  const resolveLedgerConsent = useCallback((choice: LedgerConsentChoice) => {
    setLedgerConsent(null)
    ledgerConsentResolveRef.current?.(choice)
    ledgerConsentResolveRef.current = null
  }, [])

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
  /**
   * The editor as it is NOW, not as it was when a stream's callbacks were
   * built. The rejoin effect runs on mount, before the editor exists, and
   * captured `activeEditor: null` for the whole resumed turn — so a resumed
   * generation streamed into the chat bubble while the document stayed blank.
   */
  /**
   * Tool calls being assembled this turn. The document tools replaced the
   * Canvas Markup Protocol: a model that could never emit `<canvas>` produces
   * a correct tool call, because that format is in its training data.
   */
  const toolCallsRef = useRef(new Map<number, ToolCallAccumulator>())

  const activeEditorRef = useRef<Editor | null>(activeEditor)
  useEffect(() => {
    activeEditorRef.current = activeEditor
  }, [activeEditor])

  const selectionRangeRef = useRef<{ from: number; to: number } | null>(null)
  /** Set when a finished selection edit had nowhere valid left to land. */
  const selectionGoneRef = useRef(false)
  /**
   * Selected text from a resumed job, waiting for the editor to exist so it
   * can be relocated against the real document.
   */
  const pendingSelectionTextRef = useRef<string | null>(null)

  const selectionEndRef = useRef<number | null>(null)
  /**
   * The three refs relocateResumedSelection needs, bundled once. Refs are
   * stable for the life of the hook, so this object can be built here without
   * affecting any callback's identity.
   */
  const selectionRefs = useRef({
    pendingSelectionText: pendingSelectionTextRef,
    selectionRange: selectionRangeRef,
    selectionEnd: selectionEndRef
  }).current
  const originalSelectedTextRef = useRef<string>('')
  const imagePlaceholdersRef = useRef<ImagePlaceholderEntry[]>([])
  // Chapters attached on the previous turn — feeds the scorer's continuity
  // signal so a chapter under discussion isn't dropped mid-conversation.
  const previousAttachedIdsRef = useRef<string[]>([])
  // What the model has already been sent, in the order it was sent. Session
  // scoped: a different book is a different prefix, and the provider's cache
  // is keyed on the token sequence, not on our bookkeeping.
  const ledgerRef = useRef<ContextLedger>(EMPTY_LEDGER)
  // What the ledger's cached prefix belongs to. A different book is different
  // text, and a different model is a different cache entirely — in both cases
  // the prefix we think is hot does not exist, so the ledger starts over.
  const ledgerScopeRef = useRef<string>('')
  // Reasoning display state: a tail (thinking can run to thousands of chars)
  // painted at most a few times a second (it arrives token by token).
  const reasoningTailRef = useRef('')
  const lastReasoningPaintRef = useRef(0)

  const startLLMStreamingRef = useRef<
    ((apiMessages: LLMMessage[], assistantMsgId: string, originalDocContent: string, attachmentsText: string, estimatedInputTokens: number, noActionRetriesLeft?: number, noActionRetryArmed?: boolean) => Promise<void>) | null
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
  /** Selection rewrites are short, so they repaint faster than a full document. */
  const SELECTION_PREVIEW_THROTTLE_MS = 60
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
    const editor = activeEditorRef.current
    if (editor && editor.getHTML() !== html) {
      editor.chain().setMeta('addToHistory', false).setContent(html, { emitUpdate: false }).run()
    }
  }, [])

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
  // Layering (protocol → preset → format reminder) lives in
  // utils/systemPrompt so it can be tested.
  const buildSystemPrompt = useCallback((): LLMMessage => {
    const s = useAppStore.getState()
    const preset = s.customSystemPrompts.find(p => p.id === s.activeSystemPromptId)
    return {
      role: 'system',
      content: buildChatSystemPrompt({
        customInstructions: preset?.content,
        // The prompt must teach whichever protocol the request will actually
        // use — describing tools while sending none disables editing outright.
        protocol: resolveDocumentProtocol(
          s.activeProvider,
          s.providerConfigs[s.activeProvider]?.documentProtocol
        )
      })
    }
  }, [])

  // The volatile tail (chapter index + active document). Assembly is pure and
  // lives in chat/dynamicContext (see there for the prompt-layout rationale);
  // this wrapper binds the current selection and the per-request
  // image-placeholder registry.
  const buildTail = useCallback((opts?: DynamicContextOptions): string => {
    return buildVolatileTail(selectedText, preserveImagesWithPlaceholders, opts)
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

  // The callback set that renders one streamed response into the chat
  // bubble and the editor. Extracted from startLLMStreaming so the rejoin
  // path (a generation that outlived the tab) drives the EXACT same
  // rendering/parsing/settling logic instead of a second copy of it.
  const buildStreamCallbacks = useCallback((ctx: StreamRenderContext): StreamCallbacks => {
    const { apiMessages, assistantMsgId, originalDocContent, attachmentsText, estimatedInputTokens, noActionRetriesLeft, noActionRetryArmed = true } = ctx
    const s = useAppStore.getState()

    return {
      onToolCallDelta: (delta) => {
        applyToolCallDelta(toolCallsRef.current, {
          index: delta.index,
          id: delta.id,
          function: { name: delta.name, arguments: delta.argumentsText },
          replace: delta.replace
        })

        // Render the document as it is written, exactly as the old tag
        // protocol did: the partial `html` argument is readable long before
        // the JSON closes (measured on a real stream, 205 deltas, every one
        // of them renderable).
        const acc = toolCallsRef.current.get(delta.index)
        if (!acc) return
        const partial = partialStringArgument(acc.argumentsText, 'html')
        if (partial === null) return

        const now = Date.now()
        const editor = activeEditorRef.current
        if (!editor) return

        if (acc.name === 'update_document') {
          if (now - lastCanvasPreviewRef.current < CANVAS_PREVIEW_THROTTLE_MS) return
          lastCanvasPreviewRef.current = now
          canvasPreviewActiveRef.current = true
          setSaveStatus('unsaved')
          editor.chain()
            .setMeta('addToHistory', false)
            .setContent(restoreImagesFromPlaceholders(trimIncompleteHtmlTail(partial)), { emitUpdate: false })
            .run()
          return
        }

        // Selection rewrites stream too. The tag protocol previewed these and
        // the first tool migration did not, which read as "streaming stopped
        // working" to anyone whose main use is rewriting a selection.
        if (acc.name === 'replace_selection') {
          relocateResumedSelection(editor, selectionRefs)
          if (!selectionRangeRef.current) return
          if (now - lastSelectionPreviewRef.current < SELECTION_PREVIEW_THROTTLE_MS) return
          lastSelectionPreviewRef.current = now

          const { from } = selectionRangeRef.current
          const currentEnd = selectionEndRef.current ?? selectionRangeRef.current.to
          const range = clampSelectionRange(from, currentEnd, editor.state.doc.content.size)
          if (!range) return

          const tempDiv = document.createElement('div')
          tempDiv.innerHTML = restoreImagesFromPlaceholders(trimIncompleteHtmlTail(partial))
          const slice = ProseMirrorDOMParser.fromSchema(editor.state.schema).parseSlice(tempDiv)

          const tr = editor.state.tr
          tr.replace(range.from, range.to, slice)
          editor.view.dispatch(tr)
          selectionEndRef.current = range.from + slice.size
          setSaveStatus('unsaved')
        }
      },
      onReasoning: (text: string) => {
        // Thinking, shown live so a minute of reasoning is not dead air.
        // Throttled and tail-only: this fires per delta, and the store drives
        // the whole chat panel's rendering.
        reasoningTailRef.current = (reasoningTailRef.current + text).slice(-REASONING_TAIL_CHARS)
        const now = Date.now()
        if (now - lastReasoningPaintRef.current < REASONING_PAINT_MS) return
        lastReasoningPaintRef.current = now
        useAppStore.getState().setStreamingReasoning(reasoningTailRef.current)
      },
      onChunk: (chunk: string) => {
        // The first visible token ends the thinking display.
        if (reasoningTailRef.current) {
          reasoningTailRef.current = ''
          useAppStore.getState().setStreamingReasoning('')
        }
        accumulatedTextRef.current += chunk
        const raw = accumulatedTextRef.current

        // Incremental tag split (pure; chat/streamHandlers): routes
        // document markup away from the chat bubble as it streams.
        const { chatText, canvasText, selectionReplaceText, isSelectionEdit } = splitStreamingResponse(raw)

        // Prepend visual attachment details to conversational text.
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
          // Throttle the live preview: applying it on every token re-parses
          // the whole growing replacement and re-renders ProseMirror each
          // time (O(n²)), stuttering past a few paragraphs. ~60ms ≈ 16fps is
          // smooth; the final, exact result is applied in onDone regardless.
          const now = Date.now()
          const cleanedText = stripIncompleteEndTag(selectionReplaceText)
          const selectionEditor = activeEditorRef.current
          // A rejoined turn has the selected text but no range — without this
          // the whole resumed rewrite previewed nothing, because the guard
          // below reads selectionRangeRef and it was still null.
          if (selectionEditor) relocateResumedSelection(selectionEditor, selectionRefs)
          if (
            cleanedText &&
            selectionEditor &&
            selectionRangeRef.current &&
            now - lastSelectionPreviewRef.current >= SELECTION_PREVIEW_THROTTLE_MS
          ) {
            lastSelectionPreviewRef.current = now
            const { from } = selectionRangeRef.current
            const currentEnd = selectionEndRef.current ?? selectionRangeRef.current.to

            const restoredText = restoreImagesFromPlaceholders(cleanedText)
            const tempDiv = document.createElement('div')
            tempDiv.innerHTML = restoredText
            const slice = ProseMirrorDOMParser.fromSchema(selectionEditor.state.schema).parseSlice(tempDiv)

            // The document may have moved on since the selection was taken.
            const range = clampSelectionRange(from, currentEnd, selectionEditor.state.doc.content.size)
            if (range) {
              const tr = selectionEditor.state.tr
              tr.replace(range.from, range.to, slice)
              selectionEditor.view.dispatch(tr)

              selectionEndRef.current = range.from + slice.size
              setSaveStatus('unsaved')
            }
          }
        } else if (canvasText.trim()) {
          setSaveStatus('unsaved')
          // Stream the document into the editor. The store is deliberately
          // NOT updated here: it would churn persistence every tick and
          // fight Editor.tsx's content-prop sync. onDone/onError own the
          // final state (see settleCanvasPreview).
          const now = Date.now()
          const editor = activeEditorRef.current
          if (editor && now - lastCanvasPreviewRef.current >= CANVAS_PREVIEW_THROTTLE_MS) {
            lastCanvasPreviewRef.current = now
            canvasPreviewActiveRef.current = true
            const partial = restoreImagesFromPlaceholders(trimIncompleteHtmlTail(canvasText))
            editor.chain()
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


        // Tool calls first: they are the protocol now. The legacy tag parse
        // stays behind them for models with no tool support, and for a turn
        // that answered in prose — deleting it would strand those.
        const toolCalls = finishToolCalls(toolCallsRef.current)
        const documentCall = toolCalls.find(c =>
          c.name === 'update_document' || c.name === 'edit_document' || c.name === 'replace_selection'
        )

        // Classify the completed response (pure, tested in utils/text).
        // Priority: selection_replace > localized edits > full-doc canvas.
        const parsed = documentCall
          ? toolCallToParsedResponse(documentCall, fullText)
          : parseAssistantResponse(fullText)
        const finalChatText = parsed.chatText

        // Whether the document needed changing is the MODEL's call, not ours —
        // guessing intent from the prompt retried perfectly good conversation.
        // What the client CAN judge is whether the reply is self-consistent, so
        // only two real failures retry (see detectFailedDocumentUpdate): edit
        // markup the parser rejected, and a stated document change that carried
        // no markup at all. Both used to surface as a success message over an
        // unchanged document. Retry with the failed reply quoted back, then
        // give up loudly rather than silently.
        // A document tool call IS the declaration, so the legacy text checks
        // do not apply to it: demanding a <doc_status> line as well would
        // retry a turn whose only fault is that the tool returned nothing —
        // and the warning below explains that far better than a retry.
        const failedUpdate = documentCall
          ? null
          : parsed.kind === 'chat' ? detectFailedDocumentUpdate(fullText) : null
        if (
          noActionRetryArmed &&
          noActionRetriesLeft > 0 &&
          failedUpdate !== null
        ) {
          settleCanvasPreview(originalDocContent)
          s.setMessages(useAppStore.getState().messages.map(m =>
            m.id === assistantMsgId
              ? { ...m, content: `🔁 ${
                    failedUpdate === 'malformed'
                      ? 'That reply used a document-edit format I could not apply'
                      : failedUpdate === 'undeclared'
                      ? 'That reply skipped the required status declaration'
                      : 'That reply said the document was updated but sent no update'
                  } — retrying (${MAX_NO_ACTION_RETRIES - noActionRetriesLeft + 1}/${MAX_NO_ACTION_RETRIES})…` }
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
            noActionRetriesLeft - 1,
            noActionRetryArmed
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
          selectionGone: selectionGoneRef.current,
          // The model called a document tool and the call yielded nothing
          // applicable — unusable arguments, or an empty edit list. Without
          // this the turn ends in silence: no change, no explanation, which is
          // indistinguishable from the model deciding not to edit.
          toolCallProducedNothing: !!documentCall && parsed.kind === 'chat',
          exhaustedNoActionRetries:
            noActionRetryArmed &&
            noActionRetriesLeft === 0 &&
            failedUpdate !== null,
          // A rejoined turn has no request to replay, so it cannot retry — and
          // silence is the worst outcome: the user watched it stream and then
          // saw nothing reach the document, with no explanation.
          //
          // Only the two failures that mean content was LOST qualify. A merely
          // undeclared reply is a protocol lapse, not evidence of loss, and
          // warning about every one of those would shout over ordinary chat.
          unretriableFailedUpdate:
            !noActionRetryArmed && (failedUpdate === 'malformed' || failedUpdate === 'claimed'),
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
          const finalEditor = activeEditorRef.current
          if (finalEditor) relocateResumedSelection(finalEditor, selectionRefs)
          if (cleanedText && finalEditor && selectionRangeRef.current) {
            const restoredText = stripBlankParagraphs(restoreImagesFromPlaceholders(cleanedText))
            const diffed = diffHtml(originalSelectedTextRef.current, restoredText)
            const { from } = selectionRangeRef.current
            const currentEnd = selectionEndRef.current ?? selectionRangeRef.current.to

            const tempDiv = document.createElement('div')
            tempDiv.innerHTML = diffed
            const slice = ProseMirrorDOMParser.fromSchema(finalEditor.state.schema).parseSlice(tempDiv)

            const range = clampSelectionRange(from, currentEnd, finalEditor.state.doc.content.size)
            if (range) {
              const tr = finalEditor.state.tr
              tr.replace(range.from, range.to, slice)
              finalEditor.view.dispatch(tr)

              s.updateActiveDocument({ content: finalEditor.getHTML() })
            } else {
              // The selection is gone (chapter switched, document shortened).
              // Say so rather than throwing the turn away: the text is right
              // there in the chat for the user to place themselves.
              selectionGoneRef.current = true
            }
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
    // selectionRefs is a ref's `.current`, so it never changes identity — it is
    // listed only to satisfy exhaustive-deps, and adding it cannot destabilise
    // these callbacks (which must stay stable; see the timeout note in CLAUDE.md).
  }, [preserveImagesWithPlaceholders, restoreImagesFromPlaceholders, forceSave, setSaveStatus, settleCanvasPreview, selectionRefs])

  // Shared LLM Streaming engine.
  const startLLMStreaming = useCallback(async (
    apiMessages: LLMMessage[],
    assistantMsgId: string,
    originalDocContent: string,
    attachmentsText: string,
    estimatedInputTokens: number,
    noActionRetriesLeft: number = MAX_NO_ACTION_RETRIES,
    // Armed for every real request. Disarmed only where there is no request to
    // replay (the rejoin reader), since a retry would have nothing to re-send.
    noActionRetryArmed: boolean = true
  ) => {
    const s = useAppStore.getState()

    // Start each turn with no leftover thinking on screen.
    toolCallsRef.current = new Map()
    selectionGoneRef.current = false
    reasoningTailRef.current = ''
    lastReasoningPaintRef.current = 0
    s.setStreamingReasoning('')

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
        {
          ...s.providerConfigs[s.activeProvider],
          provider: s.activeProvider,
          debug: s.debugMode,
          signal,
          conversationId: s.activeBookId,
          // Job description for the remote transport: a reloaded tab uses
          // it to find this generation and stream it back into this bubble.
          // The tools this turn can actually use: replace_selection only
          // with a selection. Omitted entirely on the markup protocol —
          // offering both invites the model to mix them, and the tag parser
          // then sees a reply with no tags.
          tools: resolveDocumentProtocol(s.activeProvider, s.providerConfigs[s.activeProvider]?.documentProtocol) === 'tools'
            ? toOpenAITools(toolsForTurn({
                hasSelection: !!selectionRangeRef.current
              }))
            : undefined,
          remoteMeta: {
            bookId: s.activeBookId,
            documentId: s.activeDocumentId,
            assistantMessageId: assistantMsgId,
            kind: 'chat' as const,
            // Survives the reload that the in-memory selection range cannot.
            selectedText: originalSelectedTextRef.current || undefined
          }
        },
        buildStreamCallbacks({
          apiMessages,
          assistantMsgId,
          originalDocContent,
          attachmentsText,
          estimatedInputTokens,
          noActionRetriesLeft,
          noActionRetryArmed
        })
      )
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      s.setStreaming(false)
      setErrorMsg(err.message || 'Failed to initialize LLM stream.')
    }
  }, [activeEditor, selectedText, buildStreamCallbacks])

  // Self-reference for the no-action retry: onDone re-invokes the streaming
  // engine, which cannot reference its own useCallback binding directly.
  useEffect(() => {
    startLLMStreamingRef.current = startLLMStreaming
  }, [startLLMStreaming])

  // ── Rejoin a generation that outlived the tab (spec §5) ───────────────────
  // With the remote transport the backend keeps generating after the tab is
  // discarded (mobile Firefox does this within seconds of an app switch). On
  // mount we ask the server whether the job recorded in localStorage is still
  // worth reading and, if so, stream it back into the SAME assistant bubble —
  // the reloaded tab visibly continues instead of showing a dead "Thinking…".
  const rejoinAttemptedRef = useRef(false)
  useEffect(() => {
    // StrictMode mounts twice in development; one rejoin per page load only.
    if (rejoinAttemptedRef.current) return
    rejoinAttemptedRef.current = true

    void (async () => {
      // Cheap short-circuit: no persisted job means no network call at all.
      const job = await findResumableJob()
      if (!job) return void markInterruptedPlaceholders()

      const assistantMsgId = job.meta.assistantMessageId
      // Only chat jobs stream into a bubble. Anything else is left alone to
      // expire on its own retention timer.
      if (job.meta.kind && job.meta.kind !== 'chat') return void markInterruptedPlaceholders()
      if (!assistantMsgId) return void markInterruptedPlaceholders()
      // The chat history arrives with the server sync, which typically lands
      // AFTER this effect runs — waiting for the bubble is what makes the
      // rejoin work on a cold reload rather than only on a warm remount.
      if (!(await waitForMessage(assistantMsgId))) return

      const s = useAppStore.getState()
      if (s.isStreaming) return

      // The pre-stream document snapshot died with the tab; the version
      // snapshot taken before the send is still in history if the user wants
      // to revert, so diffing against the current content is the safe base.
      //
      // It has to be the LOADED content. Chapters lazy-load: after a cold
      // reload the store holds the document with `content: ''` until its fetch
      // lands, and this ran before it. An empty base made every <edit> block
      // fail to match, and the completion path then wrote the base back —
      // EMPTYING the chapter. Waiting for the content is the difference
      // between a diff and data loss.
      await s.ensureDocumentContents([s.activeDocumentId])
      const reloaded = useAppStore.getState()
      const originalDocContent = reloaded.documents.find(d => d.id === reloaded.activeDocumentId)?.content || ''

      // The selection range died with the tab, but the TEXT was persisted with
      // the job. Restoring it lets the completion path locate the passage the
      // way <edit> blocks do — by content, not by position — instead of
      // dropping a finished rewrite because a ref was empty.
      if (job.meta.selectedText) {
        originalSelectedTextRef.current = job.meta.selectedText
        // Relocated against the LIVE document, not the HTML string: a
        // plain-text index is not a ProseMirror position. Deferred until the
        // editor exists, since the rejoin runs before it mounts.
        pendingSelectionTextRef.current = job.meta.selectedText
      }

      abortControllerRef.current = new AbortController()
      accumulatedTextRef.current = ''
      // A rejoin skips startLLMStreaming, so the per-turn reset lives here too.
      toolCallsRef.current = new Map()
      s.setStreaming(true)

      // Watchdog: if the job is gone or the stream never produces an event,
      // the UI must not sit on "generating" forever. Any terminal callback
      // clears this; firing it aborts the reader so the finally below runs.
      let sawEvent = false
      const watchdog = window.setTimeout(() => {
        if (!sawEvent) abortControllerRef.current?.abort()
      }, REJOIN_FIRST_EVENT_TIMEOUT_MS)

      // Re-attach from 0 rather than from the persisted offset: the render
      // path parses the response as a whole (a <canvas>/<edit> tag opened
      // before the offset must be seen), and the reload destroyed the
      // accumulated raw text. Replaying is safe because every chunk RE-RENDERS
      // the bubble from the accumulator instead of appending to it. The
      // persisted offset still decides whether the job is worth rejoining at
      // all, and drives resumes by callers that kept their partial text.
      const baseCallbacks = buildStreamCallbacks({
        // No request to replay, so the no-action retry is disarmed (0):
        // this reader only renders what the job emits.
        apiMessages: [],
        assistantMsgId,
        originalDocContent,
        attachmentsText: '',
        estimatedInputTokens: 0,
        noActionRetriesLeft: 0,
        noActionRetryArmed: false
      })

      try {
        await resumeRemoteGeneration(job.jobId, 0, {
          // Spread FIRST. Rebuilding this field by field dropped
          // onToolCallDelta, so a resumed generation replayed its tool call to
          // a listener that no longer existed and the document never changed —
          // the same mistake the debug wrapper in llm.ts made with the same
          // consequence.
          ...baseCallbacks,
          onChunk: (chunk) => { sawEvent = true; baseCallbacks.onChunk(chunk) },
          onDone: (text, usage) => { sawEvent = true; baseCallbacks.onDone(text, usage) },
          onError: (err) => { sawEvent = true; baseCallbacks.onError(err) }
        }, abortControllerRef.current.signal)
      } catch (e) {
        // Problem: setStreaming(true) sat before an unguarded await. When the
        //   job had expired (or the server restarted, or the stream 404'd),
        //   the throw escaped as an unhandled rejection and the UI was stuck
        //   showing "is streaming changes…" with nothing ever arriving.
        // Fix: every exit path reports and then clears the streaming flag.
        const message = e instanceof Error ? e.message : String(e)
        console.warn('[Rejoin] could not resume generation', message)
        useAppStore.setState((st) => ({
          messages: st.messages.map(m =>
            m.id === assistantMsgId && (!m.content || m.content === 'Thinking...')
              ? { ...m, content: '⚠️ The generation could not be resumed after the page reloaded — it may have finished or expired on the server. Please resend if the reply is missing.' }
              : m
          )
        }))
        clearPersistedGenerationJob()
      } finally {
        window.clearTimeout(watchdog)
        // The terminal callbacks normally clear this; do it unconditionally so
        // an abort or an early throw cannot leave the app "generating".
        if (useAppStore.getState().isStreaming) useAppStore.getState().setStreaming(false)
      }
    })()
  }, [buildStreamCallbacks])

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
  // and whole-book plan execution. Returns null when
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

    const ledgerScope = `${s.activeBookId ?? ''}|${s.activeProvider}|${s.providerConfigs[s.activeProvider]?.model ?? ''}`
    if (ledgerScope !== ledgerScopeRef.current) {
      ledgerRef.current = EMPTY_LEDGER
      ledgerScopeRef.current = ledgerScope
    }

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
      previousAttachedIds: previousAttachedIdsRef.current,
      ledgerIds: ledgerRef.current.entries.map(e => e.id)
    })
    previousAttachedIdsRef.current = selection.attachedIds

    const systemPrompt = buildSystemPrompt()

    // Prompt layout: the stable prefix is what makes provider prompt caching
    // effective turn over turn.
    // History is budgeted against the MODEL's window, not a flat number. A
    // 262144-token local endpoint was being trimmed at ~20k tokens of Chinese
    // while a 32k model would have been handed a prompt it must silently
    // truncate — and truncation hits the FRONT of the prompt, which is exactly
    // the cached prefix. `estimateTokens` counts CJK at ~1 token/char: the
    // length/4 rule used elsewhere underestimates Chinese four-fold.
    const historyTexts = historySource
      .filter(m => m.id !== 'welcome')
      .map(m => ({
        role: m.role,
        content: stripChatDisplayArtifacts(m.content),
        images: m.images
      }))
    const activeDocContent = s.documents.find(d => d.id === s.activeDocumentId)?.content ?? ''
    const historyBudget = historyBudgetChars({
      contextTokens: resolveContextWindowTokens(
        s.activeProvider,
        s.providerConfigs[s.activeProvider]?.model ?? '',
        s.discoveredContextWindows[s.providerConfigs[s.activeProvider]?.model ?? '']
      ),
      maxOutputTokens: s.providerConfigs[s.activeProvider]?.maxOutputTokens ?? 16_384,
      // Everything else this turn sends: system prompt, the ledger block and
      // the volatile tail. The ledger is not built yet, so its members are
      // priced from the documents they will render.
      fixedTokens:
        estimateTokens(systemPrompt.content) +
        estimateTokens(activeDocContent) +
        ledgerRef.current.entries.reduce((sum, e) => sum + Math.ceil(e.chars * 0.9), 0),
      cjkRatio: cjkRatioOf(historyTexts.map(m => m.content).join('') || activeDocContent)
    })
    const historyMessages: LLMMessage[] = trimHistoryForContext(
      historyTexts,
      { maxChars: historyBudget }
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
    const autoIds = selection.autoIds
    let dynamicContext: string
    let attachmentsText: string
    // The stable block ahead of the history: either the whole-book sticky
    // prefix or the context ledger. Both are cacheable; they never coexist,
    // since whole-book already provides every chapter.
    let bookPrefixMessages: LLMMessage[] = []

    if (wholeBookPlan) {
      const { mode, sticky, docs, batches, budgetChars } = wholeBookPlan

      if (mode === 'full' && sticky) {
        bookPrefixMessages = buildStickyBookPrefix(docs)
        attachedIds = docs.map(d => d.id)
        dynamicContext = buildTail()
        attachmentsText = `[Attached Context: Whole book (${docs.length} chapters, sticky)]`
      } else if (mode === 'full') {
        // Rung 1: attach every chapter, single call.
        attachedIds = docs.map(d => d.id)
        dynamicContext = buildInlineReferenceBlock(attachedIds, Number.MAX_SAFE_INTEGER) +
          '\n' + buildTail()
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
        dynamicContext = buildTail({ notesBlock: notes })
        attachmentsText = `[Attached Context: Whole book (${docs.length} chapters, read in ${batches.length} batches)]`
      } else {
        // Rung 0 fast mode: structure + summaries, no full text.
        attachedIds = []
        dynamicContext = buildTail({ includeWholeBookDigest: true })
        attachmentsText = '[Attached Context: Whole-book digest (structure + summaries)]'
      }
      previousAttachedIdsRef.current = attachedIds
      // Whole-book replaces the stable block with its own; whatever the ledger
      // had cached is no longer in the prefix.
      ledgerRef.current = EMPTY_LEDGER
    } else {
      // Cache-first assembly: chapters go into an append-only block ahead of
      // the history, so an unchanged set costs nothing to re-send. New
      // admissions are ordered most-stable-first, because removing an entry
      // re-sends everything after it — so the documents the writer revises
      // constantly (the outline) belong at the END, where invalidating them
      // costs only themselves. See docs/features/cache_first_context.md.
      const bookOrder = s.documents.map(d => d.id)
      const desiredIds = orderAdmissionsByStability(
        attachedIds,
        s.documents.map(d => ({ id: d.id, updatedAt: d.updatedAt })),
        bookOrder,
        s.activeDocumentId
      )
      const docsForPlan = s.documents.map(d => ({
        id: d.id,
        chars: Math.min(d.content.length, MAX_LEDGER_DOC_CHARS),
        hash: hashContent(d.content)
      }))

      let plan: LedgerPlan = planLedgerTurn(ledgerRef.current, desiredIds, docsForPlan, s.activeDocumentId)
      if (plan.requiresConsent) {
        const choice = await requestLedgerConsent({
          droppedTitles: plan.drops
            .filter(d => d.reason === 'user-removed')
            .map(d => s.documents.find(doc => doc.id === d.id)?.title ?? d.id),
          resendChars: plan.resendChars,
          resendChapters: plan.resentIds.length + plan.appendedIds.length
        })
        if (choice === 'cancel') {
          s.setStreaming(false)
          s.setMessages(useAppStore.getState().messages.filter(m => m.id !== assistantMsgId))
          return null
        }
        if (choice === 'keep') {
          plan = planKeepingRemoved(ledgerRef.current, desiredIds, docsForPlan, s.activeDocumentId)
        }
      }

      attachedIds = plan.ledger.entries.map(e => e.id)
      bookPrefixMessages = buildLedgerMessages(attachedIds)
      ledgerRef.current = plan.ledger
      previousAttachedIdsRef.current = attachedIds
      dynamicContext = buildTail()
      attachmentsText = buildAttachmentsLabel(attachedIds, s.documents, autoIds)
    }

    const finalUserMessage: LLMMessage = {
      role: 'user',
      content: `${dynamicContext}\n\nUSER REQUEST:\n${promptText}`,
      images
    }

    const apiMessages = [systemPrompt, ...bookPrefixMessages, ...historyMessages, finalUserMessage]

    return {
      apiMessages,
      attachmentsText,
      estimatedInputTokens: Math.ceil(JSON.stringify(apiMessages).length / 4)
    }
  }, [buildSystemPrompt, buildTail, runWholeBookBatches, forceSave, requestLedgerConsent])

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
      content: ASSISTANT_PLACEHOLDER,
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

    await startLLMStreaming(request.apiMessages, assistantMsgId, originalDocContent, request.attachmentsText, request.estimatedInputTokens)
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
      content: ASSISTANT_PLACEHOLDER,
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

    await startLLMStreaming(request.apiMessages, assistantMsgId, originalDocContent, request.attachmentsText, request.estimatedInputTokens)
  }, [layoutMode, setIsChatExpanded, planWholeBook, assembleChatRequest, startLLMStreaming])

  // Stop generation
  const handleStopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    // With the remote transport, dropping the reader leaves the backend job
    // generating (and billing) on its own — stopping has to reach the server
    // too. No-op when nothing is running remotely.
    void abortRemoteGeneration()
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
    ledgerConsent,
    resolveLedgerConsent,
    resolveWholeBookConsent
  }
}
