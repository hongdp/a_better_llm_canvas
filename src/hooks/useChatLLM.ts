import { useState, useRef, useCallback, useEffect } from 'react'
import { Editor } from '@tiptap/react'
import { useAppStore } from '../store/useAppStore'
import { streamLLM, type LLMMessage } from '../services/llm'
import { findResumableJob, findJobsForBubbles, resumeRemoteGeneration, abortRemoteGeneration, type PersistedGenerationJob } from '../services/remoteGeneration'
import type { StreamCallbacks } from '../types/llm'
import type { AppState } from '../store/types'
import { getTimestampId, stripIncompleteEndTag, trimIncompleteHtmlTail } from '../utils/text'
import { trimHistoryForContext, stripChatDisplayArtifacts, buildAttachmentsLabel } from '../utils/llmContext'
import { replaceImagesWithPlaceholders, restoreImagePlaceholders, type ImagePlaceholderEntry } from '../utils/imagePreservation'
import { selectReferenceChapters } from '../utils/contextSelection'
import { buildChatSystemPrompt } from '../utils/systemPrompt'
import { applyToolCallDelta, finishToolCalls, type ToolCallAccumulator } from '../utils/toolCallStream'
import { toOpenAITools } from '../utils/documentTools'
import { resolveDocumentProtocol } from '../utils/protocolChoice'
import {
  resolveContextWindowTokens,
  estimateTokens,
  historyBudgetChars,
  cjkRatioOf
} from '../utils/contextWindow'
import { getCacheProfile, targetPromptTokens } from '../utils/providerProfile'
import type { HistorySourceMessage } from './chat/types'
import { ASSISTANT_PLACEHOLDER, INTERRUPTED_NOTICE, RECONNECT_FAILED_NOTICE, isUnfinishedBubble, REASONING_TAIL_CHARS, REASONING_PAINT_MS, relocateResumedSelection, splitStreamingResponse, buildCompletionWarnings } from './chat/streamHandlers'
import { buildLedgerMessages, buildVolatileTail, buildInlineReferenceBlock, type DynamicContextOptions } from './chat/dynamicContext'
import { replaceSelectionWithHtml } from './chat/selectionReplace'
import { AgentRun, type RunObserver } from '../agent/run'
import { ToolRegistry, toToolSpecs } from '../agent/registry'
import { DOCUMENT_WRITE_TOOLS } from '../agent/tools/documentWrites'
import { DEFAULT_BUDGETS, DEFAULT_POLICY, defaultMaxSteps } from '../agent/policy'
import type { ToolContext } from '../agent/types'
import {
  EMPTY_LEDGER,
  hashContent,
  planLedgerTurn,
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
// How long a rejoin may take to ATTACH — to hear anything at all from the
// stream, the server's immediate `attached` frame included. It is not a bound
// on the model: grok-4.6 was measured at 230s to its first token, and a bound
// on "first text" aborted every rejoin of a turn that was merely thinking.
const REJOIN_FIRST_EVENT_TIMEOUT_MS = 20_000

/** What a run reports into: the bubble, the document it may rewrite, the cost estimate. */
interface RunInfo {
  assistantMsgId: string
  originalDocContent: string
  attachmentsText: string
  estimatedInputTokens: number
}

/** Everything one streamed step needs in order to render itself. */
interface StreamRenderContext extends RunInfo {
  run: AgentRun
  toolCtx: ToolContext
}

/**
 * The chat's tools (docs/features/agentic_chat_loop.md). Module-level: the
 * registry is static, so it can never destabilise a callback's identity.
 */
const CHAT_TOOLS = new ToolRegistry(DOCUMENT_WRITE_TOOLS)

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
 * Settle every bubble that never received its reply — by asking the server,
 * which is the only party that knows whether a job can still fill it.
 *
 * Problem: this used to retire every placeholder whenever THIS browser held no
 *   job record. The record is one localStorage slot on one origin, so a turn
 *   sent from another device (or over the LAN address instead of localhost, or
 *   followed by any other generation) had none — and was declared
 *   "Interrupted" while its job was running, the reply then arriving nowhere.
 *   A failed lookup was read the same way: "could not ask" became "no job".
 * Fix: a bubble is retired only on the server's word. One the server still has
 *   a job for is handed back to be rejoined; when the server cannot be asked,
 *   nothing is touched and the next load asks again.
 *
 * Costs nothing in the common case: no unfinished bubble, no request.
 */
async function reconcileUnfinishedBubbles(): Promise<PersistedGenerationJob | null> {
  // The history arrives with the server sync, typically after this runs.
  await waitForStore(state => state.messages.length > 0, 15_000)
  const s = useAppStore.getState()
  const unfinished = s.messages.filter(m => m.role === 'assistant' && isUnfinishedBubble(m.content))
  if (unfinished.length === 0) return null

  const lookup = await findJobsForBubbles(unfinished.map(m => m.id), s.activeBookId)
  if (!lookup.known) return null

  // No job anywhere: the turn is dead, and must not pass for one in progress.
  const orphaned = new Set(
    unfinished.filter(m => !lookup.jobs.has(m.id) && m.content !== INTERRUPTED_NOTICE).map(m => m.id)
  )
  if (orphaned.size > 0) {
    const latest = useAppStore.getState()
    latest.setMessages(latest.messages.map(m => orphaned.has(m.id) ? { ...m, content: INTERRUPTED_NOTICE } : m))
  }

  // One reader at a time, so the newest claimed bubble wins; an older one
  // keeps its job on the server and is picked up by a later load.
  const claimed = unfinished.filter(m => lookup.jobs.has(m.id))
  const target = claimed[claimed.length - 1]
  const job = target && lookup.jobs.get(target.id)
  if (!target || !job) return null
  return { jobId: job.jobId, meta: { ...(job.meta || {}), assistantMessageId: target.id }, offset: 0 }
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
  /** The run in flight, so Stop can keep it from starting another step. */
  const currentRunRef = useRef<AgentRun | null>(null)
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
  // Time-to-first-token for the turn in flight. On a local endpoint this is
  // the ONLY cache signal — llama.cpp reports no cached-token count, and a
  // lost prefix shows up purely as prefill time.
  const turnStartedAtRef = useRef<number>(0)
  const firstTokenAtRef = useRef<number>(0)
  // Reasoning display state: a tail (thinking can run to thousands of chars)
  // painted at most a few times a second (it arrives token by token).
  const reasoningTailRef = useRef('')
  const lastReasoningPaintRef = useRef(0)

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

  /**
   * Keep the half-streamed draft after a stop, as ONE undo step, and return
   * it so the caller can write the same HTML to the store.
   *
   * Every preview write carried addToHistory:false, so the editor's history
   * knows nothing about the draft: left as is, Undo would step back through
   * the user's edits from BEFORE the turn while the draft stayed on screen.
   * Rebuild the transition instead — put the pre-stream document back outside
   * history, then apply the draft as a single recorded transaction. Undo now
   * returns exactly the pre-stream document (which the version snapshot taken
   * before the send also holds).
   *
   * Returns null when no preview reached the editor: nothing to keep.
   */
  const keepCanvasPreview = useCallback((originalHtml: string): string | null => {
    if (!canvasPreviewActiveRef.current) return null
    canvasPreviewActiveRef.current = false
    lastCanvasPreviewRef.current = 0
    const editor = activeEditorRef.current
    if (!editor) return null
    const draft = editor.getHTML()
    if (draft === originalHtml) return null
    editor.chain().setMeta('addToHistory', false).setContent(originalHtml, { emitUpdate: false }).run()
    // No emitUpdate: the caller writes the store explicitly, as every other
    // terminal path does, and Editor.tsx's content sync then sees matching
    // HTML on both sides.
    editor.commands.setContent(draft, { emitUpdate: false })
    return draft
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
    const s = useAppStore.getState()
    return buildVolatileTail(
      s.documents,
      s.activeDocumentId,
      selectedText,
      preserveImagesWithPlaceholders,
      opts
    )
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

  // The ports the turn's tools work through (src/agent/types). Built once per
  // run; every member reads refs, so a resumed turn whose editor mounts later
  // still reaches the live editor.
  const buildToolContext = useCallback((originalDocContent: string): ToolContext => ({
    getState: useAppStore.getState,
    editor: {
      current: () => activeEditorRef.current,
      // Live full-document preview (measured: ~17s to first token, then ~70s
      // of generation for a chapter rewrite — without it the user watches a
      // frozen document for the whole minute). The store is deliberately NOT
      // written here: it would churn persistence every tick and fight
      // Editor.tsx's content-prop sync. The run's end owns the final state
      // (see settleCanvasPreview).
      previewDocument: (html: string) => {
        const editor = activeEditorRef.current
        if (!editor) return
        const now = Date.now()
        if (now - lastCanvasPreviewRef.current < CANVAS_PREVIEW_THROTTLE_MS) return
        lastCanvasPreviewRef.current = now
        canvasPreviewActiveRef.current = true
        setSaveStatus('unsaved')
        editor.chain()
          .setMeta('addToHistory', false)
          .setContent(restoreImagesFromPlaceholders(html), { emitUpdate: false })
          .run()
      },
      // Selection rewrites stream too. Throttled: applying every token
      // re-parses the whole growing replacement and re-renders ProseMirror
      // each time (O(n²)); the final, exact result is applied at the end.
      previewSelection: (html: string) => {
        const editor = activeEditorRef.current
        if (!editor) return
        // A rejoined turn has the selected text but no range — without this
        // the whole resumed rewrite previewed nothing.
        relocateResumedSelection(editor, selectionRefs)
        if (!selectionRangeRef.current) return
        const now = Date.now()
        if (now - lastSelectionPreviewRef.current < SELECTION_PREVIEW_THROTTLE_MS) return
        lastSelectionPreviewRef.current = now
        const { from } = selectionRangeRef.current
        const currentEnd = selectionEndRef.current ?? selectionRangeRef.current.to
        // Null when the document has moved on since the selection was taken.
        const end = replaceSelectionWithHtml(editor, from, currentEnd, restoreImagesFromPlaceholders(html))
        if (end === null) return
        selectionEndRef.current = end
        setSaveStatus('unsaved')
      },
      replaceRange: (from: number, to: number, html: string) => {
        const editor = activeEditorRef.current
        return editor ? replaceSelectionWithHtml(editor, from, to, html) : null
      }
    },
    selection: {
      relocate: () => {
        const editor = activeEditorRef.current
        if (editor) relocateResumedSelection(editor, selectionRefs)
      },
      range: () => selectionRangeRef.current,
      end: () => selectionEndRef.current,
      originalText: () => originalSelectedTextRef.current
    },
    document: {
      original: originalDocContent,
      commit: (html: string) => useAppStore.getState().updateActiveDocument({ content: html })
    },
    images: { preserve: preserveImagesWithPlaceholders, restore: restoreImagesFromPlaceholders },
    run: { working: null, selectionAttempted: false, selectionApplied: false }
    // selectionRefs is a ref's `.current`, so it never changes identity — it is
    // listed only to satisfy exhaustive-deps (see the timeout note in CLAUDE.md).
  }), [preserveImagesWithPlaceholders, restoreImagesFromPlaceholders, setSaveStatus, selectionRefs])

  // The callback set that renders one streamed step into the chat bubble and
  // the editor. Shared by the send path and the rejoin path (a generation
  // that outlived the tab) so both drive the EXACT same rendering instead of
  // two copies of it. What a finished step MEANS — which writes run, whether
  // the turn continues — is the run's business (src/agent/run.ts).
  const buildStreamCallbacks = useCallback((rc: StreamRenderContext): StreamCallbacks => {
    const { run, toolCtx, assistantMsgId, originalDocContent, attachmentsText, estimatedInputTokens } = rc
    const s = useAppStore.getState()

    return {
      onToolCallDelta: (delta) => {
        applyToolCallDelta(toolCallsRef.current, {
          index: delta.index,
          id: delta.id,
          function: { name: delta.name, arguments: delta.argumentsText },
          replace: delta.replace
        })
        // Render the call as it is written: each tool previews its own
        // partial arguments (the document writes paint the editor).
        const acc = toolCallsRef.current.get(delta.index)
        if (acc) CHAT_TOOLS.get(acc.name)?.preview?.(acc.argumentsText, toolCtx)
      },
      onReasoning: (text: string) => {
        if (firstTokenAtRef.current === 0) firstTokenAtRef.current = Date.now()
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
        if (firstTokenAtRef.current === 0) firstTokenAtRef.current = Date.now()
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

        // The markup protocol's live previews, through the same ports the
        // tool calls use.
        if (isSelectionEdit) {
          toolCtx.selection.relocate()
          const cleanedText = stripIncompleteEndTag(selectionReplaceText)
          if (cleanedText) toolCtx.editor.previewSelection(cleanedText)
        } else if (canvasText.trim()) {
          setSaveStatus('unsaved')
          toolCtx.editor.previewDocument(trimIncompleteHtmlTail(canvasText))
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

        // Every step costs — account before deciding whether to continue.
        s.addSessionTokens(finalInputTokens, finalOutputTokens, cacheHits)
        // …and record THIS step, because session totals hide a collapse.
        s.setLastTurnCache({
          provider: s.activeProvider,
          promptTokens: finalInputTokens,
          cachedTokens: usage ? (usage.cachedPromptTokens ?? null) : null,
          firstTokenMs: firstTokenAtRef.current > 0 && turnStartedAtRef.current > 0
            ? firstTokenAtRef.current - turnStartedAtRef.current
            : null
        })

        run.stepDone({ text: fullText, nativeCalls: finishToolCalls(toolCallsRef.current) })
      },
      onError: (err: Error) => {
        run.cancel()
        s.setStreaming(false)

        const isAbort = err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('cancel')
        if (isAbort) {
          // Stop keeps what was written. This used to roll the editor back
          // on the premise that the store had never seen the draft — but the
          // store HAD captured it (see the setEditable note in Editor.tsx),
          // so a reload contradicted the screen. Committing the draft makes
          // the two identical, and keepCanvasPreview makes it one undo step.
          const draft = keepCanvasPreview(originalDocContent)
          if (draft !== null) s.updateActiveDocument({ content: draft })
          // A selection rewrite previews through real transactions, so its
          // partial text is already in the store; only the note differs.
          const keptDraft = draft !== null || lastSelectionPreviewRef.current > 0

          // The bubble was last painted mid-stream ("Updating document..." or
          // a half sentence); say what happened rather than leaving it there.
          const { chatText } = splitStreamingResponse(accumulatedTextRef.current)
          const stoppedNote = keptDraft
            ? '⏹️ Stopped. The partial draft was kept in the document — Undo (Ctrl+Z) restores the previous version.'
            : '⏹️ Stopped.'
          const stoppedText = chatText.trim() ? `${chatText.trim()}\n\n${stoppedNote}` : stoppedNote
          s.setMessages(useAppStore.getState().messages.map(m =>
            m.id === assistantMsgId
              ? { ...m, content: attachmentsText ? `${attachmentsText}\n\n${stoppedText}` : stoppedText }
              : m
          ))
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
  }, [setSaveStatus, settleCanvasPreview, keepCanvasPreview, forceSave])

  // How a run reports to the chat: the corrective-retry status line, and the
  // final bubble once the run is over.
  const buildRunObserver = useCallback((info: RunInfo): RunObserver => ({
    onCorrective: (failure, attempt, max) => {
      settleCanvasPreview(info.originalDocContent)
      const s = useAppStore.getState()
      s.setMessages(s.messages.map(m =>
        m.id === info.assistantMsgId
          ? { ...m, content: `🔁 ${
                failure === 'malformed'
                  ? 'That reply used a document-edit format I could not apply'
                  : failure === 'undeclared'
                  ? 'That reply skipped the required status declaration'
                  : 'That reply said the document was updated but sent no update'
              } — retrying (${attempt}/${max})…` }
          : m
      ))
      accumulatedTextRef.current = ''
    },
    onFinish: (summary) => {
      const s = useAppStore.getState()
      s.setStreaming(false)

      // Built AFTER the document writes, not before: whether edits beside a
      // selection landed, and whether the selection was gone, are only known
      // once the writes ran.
      const warningNote = buildCompletionWarnings({
        canvasIssue: summary.effects.canvasIssue,
        editFailedCount: summary.effects.failedEdits,
        strayMarkup: summary.strayMarkup,
        selectionGone: summary.effects.selectionGone,
        // The model called a document tool and the call yielded nothing
        // applicable — unusable arguments, or an empty edit list. Without
        // this the turn ends in silence: no change, no explanation, which is
        // indistinguishable from the model deciding not to edit.
        toolCallProducedNothing: summary.effects.producedNothing,
        exhaustedNoActionRetries: summary.exhaustedCorrective,
        // A rejoined turn has no request to replay, so it cannot retry — and
        // silence is the worst outcome: the user watched it stream and then
        // saw nothing reach the document, with no explanation.
        unretriableFailedUpdate: summary.unretriableFailedUpdate,
        reinsertedImages: summary.effects.reinsertedImages
      })

      const chatText = summary.chatText.trim() || 'Document updated successfully.'
      const displayChatText = (info.attachmentsText ? `${info.attachmentsText}\n\n${chatText}` : chatText) + warningNote
      s.setMessages(useAppStore.getState().messages.map(m =>
        m.id === info.assistantMsgId ? { ...m, content: displayChatText } : m
      ))

      // Converge the editor with whatever the store ended up holding.
      // Required after a live preview: on the paths that keep the original
      // HTML (truncated, elided, tag-free reply) the store value never
      // changes, so nothing else would clear the streamed draft.
      const settled = useAppStore.getState()
      settleCanvasPreview(
        settled.documents.find(d => d.id === settled.activeDocumentId)?.content ?? info.originalDocContent
      )
      forceSave()
    }
  }), [settleCanvasPreview, forceSave])

  // One model call of a run: per-step resets, the abort controller, the
  // selection capture, and the request with the tools this step offers.
  const streamStep = useCallback(async (messages: LLMMessage[], stepIndex: number, rc: StreamRenderContext) => {
    const s = useAppStore.getState()

    // Clock for time-to-first-token. Reset per step, corrective ones
    // included: each one pays its own prefill.
    turnStartedAtRef.current = Date.now()
    firstTokenAtRef.current = 0

    // Start each step with no leftover tool calls or thinking on screen.
    toolCallsRef.current = new Map()
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

    // Offered AFTER the selection capture: replace_selection exists only
    // when there is a selection to replace. On the markup protocol the
    // writes are tags, so nothing is sent unless a non-write tool exists —
    // offering both invites the model to mix them, and the tag parser then
    // sees a reply with no tags.
    const offered = rc.run.offeredTools()

    try {
      await streamLLM(
        messages,
        {
          ...s.providerConfigs[s.activeProvider],
          provider: s.activeProvider,
          debug: s.debugMode,
          signal,
          conversationId: s.activeBookId,
          tools: offered.length > 0 ? toOpenAITools(toToolSpecs(offered)) : undefined,
          // Job description for the remote transport: a reloaded tab uses
          // it to find this generation and stream it back into this bubble.
          remoteMeta: {
            bookId: s.activeBookId,
            documentId: s.activeDocumentId,
            assistantMessageId: rc.assistantMsgId,
            kind: 'chat' as const,
            // Survives the reload that the in-memory selection range cannot.
            selectedText: originalSelectedTextRef.current || undefined
          }
        },
        buildStreamCallbacks({
          ...rc,
          estimatedInputTokens: stepIndex === 0 ? rc.estimatedInputTokens : Math.ceil(JSON.stringify(messages).length / 4)
        })
      )
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      rc.run.cancel()
      s.setStreaming(false)
      setErrorMsg(err.message || 'Failed to initialize LLM stream.')
    }
  }, [activeEditor, selectedText, buildStreamCallbacks])

  /**
   * Build the run for one turn. `canContinue` is false for a reader that has
   * no request to re-issue (the rejoin path): no corrective step, no
   * follow-up step, and no "gave up" warning either.
   */
  const createRun = useCallback((info: RunInfo, initialMessages: LLMMessage[], canContinue: boolean): StreamRenderContext => {
    const s = useAppStore.getState()
    const toolCtx = buildToolContext(info.originalDocContent)
    const rcRef: { current: StreamRenderContext | null } = { current: null }
    const run = new AgentRun({
      registry: CHAT_TOOLS,
      ctx: toolCtx,
      writeProtocol: resolveDocumentProtocol(s.activeProvider, s.providerConfigs[s.activeProvider]?.documentProtocol),
      driver: (messages, stepIndex) => streamStep(messages, stepIndex, rcRef.current as StreamRenderContext),
      observer: buildRunObserver(info),
      budgets: { ...DEFAULT_BUDGETS, maxSteps: canContinue ? defaultMaxSteps(s.activeProvider) : 1 },
      policy: DEFAULT_POLICY,
      canContinue,
      initialMessages
    })
    rcRef.current = { ...info, run, toolCtx }
    currentRunRef.current = run
    return rcRef.current
  }, [buildToolContext, buildRunObserver, streamStep])

  // A turn: build the run, stream its first step. Corrective and follow-up
  // steps are started by the run itself.
  const startTurn = useCallback(async (apiMessages: LLMMessage[], info: RunInfo) => {
    const rc = createRun(info, apiMessages, true)
    await rc.run.start()
  }, [createRun])

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
      // The record in this browser is the fast path: it names the job without
      // waiting for the history. Only chat jobs stream into a bubble; anything
      // else is left alone to expire on its own retention timer.
      let job = await findResumableJob()
      if (job && ((job.meta.kind && job.meta.kind !== 'chat') || !job.meta.assistantMessageId)) job = null
      // No usable record HERE says nothing about the server — ask it before
      // declaring any turn dead (see reconcileUnfinishedBubbles).
      if (!job) job = await reconcileUnfinishedBubbles()
      if (!job) return

      const assistantMsgId = job.meta.assistantMessageId
      if (!assistantMsgId) return
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
      //
      // Problem: only onChunk/onDone/onError counted as an event. A rejoined
      //   turn that was still reasoning delivers `attached` and `reasoning`
      //   frames and nothing else — for minutes — so the watchdog aborted a
      //   perfectly live stream at 20s. The abort then reached onError as an
      //   AbortError, which reports a USER stop: the bubble read "Stopped."
      //   for a job nobody stopped, that went on to finish (9406 chars,
      //   measured) with no reader left to render it.
      // Fix: every frame is a sign of life, and an abort this watchdog caused
      //   is reported as what it is (see onError below).
      let sawEvent = false
      let watchdogFired = false
      const alive = () => { sawEvent = true }
      const watchdog = window.setTimeout(() => {
        if (sawEvent) return
        watchdogFired = true
        abortControllerRef.current?.abort()
      }, REJOIN_FIRST_EVENT_TIMEOUT_MS)

      // Re-attach from 0 rather than from the persisted offset: the render
      // path parses the response as a whole (a <canvas>/<edit> tag opened
      // before the offset must be seen), and the reload destroyed the
      // accumulated raw text. Replaying is safe because every chunk RE-RENDERS
      // the bubble from the accumulator instead of appending to it. The
      // persisted offset still decides whether the job is worth rejoining at
      // all, and drives resumes by callers that kept their partial text.
      // No request to replay, so the run cannot continue: no corrective
      // step, no follow-up — this reader only renders what the job emits.
      const baseCallbacks = buildStreamCallbacks(createRun(
        { assistantMsgId, originalDocContent, attachmentsText: '', estimatedInputTokens: 0 },
        [],
        false
      ))

      try {
        await resumeRemoteGeneration(job.jobId, 0, {
          // Spread FIRST. Rebuilding this field by field dropped
          // onToolCallDelta, so a resumed generation replayed its tool call to
          // a listener that no longer existed and the document never changed —
          // the same mistake the debug wrapper in llm.ts made with the same
          // consequence.
          ...baseCallbacks,
          onAttached: () => { alive() },
          onReasoning: (text) => { alive(); baseCallbacks.onReasoning?.(text) },
          onToolCallDelta: (delta) => { alive(); baseCallbacks.onToolCallDelta?.(delta) },
          onChunk: (chunk) => { alive(); baseCallbacks.onChunk(chunk) },
          onDone: (text, usage) => { alive(); baseCallbacks.onDone(text, usage) },
          onError: (err) => {
            if (watchdogFired) {
              // Our abort, not the user's: baseCallbacks.onError would call it
              // "Stopped" and commit a draft. The job record is left in place
              // (the transport keeps it on any non-terminal exit), so the next
              // load attaches again instead of finding nothing.
              useAppStore.getState().setStreaming(false)
              useAppStore.setState((st) => ({
                messages: st.messages.map(m =>
                  m.id === assistantMsgId && isUnfinishedBubble(m.content)
                    ? { ...m, content: RECONNECT_FAILED_NOTICE }
                    : m
                )
              }))
              return
            }
            alive()
            baseCallbacks.onError(err)
          }
        }, abortControllerRef.current.signal, job.meta)
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
            m.id === assistantMsgId && (!m.content || isUnfinishedBubble(m.content))
              ? { ...m, content: RECONNECT_FAILED_NOTICE }
              : m
          )
        }))
        // The job record is deliberately NOT cleared. This used to throw the
        // way back away on any failure, including ones the job survived; the
        // next load validates the record against the server and forgets it
        // only once the job is really gone.
      } finally {
        window.clearTimeout(watchdog)
        // The terminal callbacks normally clear this; do it unconditionally so
        // an abort or an early throw cannot leave the app "generating".
        if (useAppStore.getState().isStreaming) useAppStore.getState().setStreaming(false)
      }
    })()
  }, [buildStreamCallbacks, createRun])

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
    // Budget against the provider's price cliff where it has one, not just its
    // window: xAI's long-context tier counts CACHED tokens toward the
    // threshold and doubles every rate above it, so a well-cached conversation
    // can cross the line with nothing looking wrong.
    const cacheProfile = getCacheProfile(s.activeProvider)
    const historyBudget = historyBudgetChars({
      contextTokens: targetPromptTokens(
        cacheProfile,
        resolveContextWindowTokens(
          s.activeProvider,
          s.providerConfigs[s.activeProvider]?.model ?? '',
          s.discoveredContextWindows[s.providerConfigs[s.activeProvider]?.model ?? '']
        )
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
        dynamicContext = buildInlineReferenceBlock(s.documents, attachedIds, Number.MAX_SAFE_INTEGER) +
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

      // Removing a chapter used to raise a consent card here (the drop costs
      // a re-prefill of everything after it in the cached prefix). Removed by
      // request: the user's removal is honored silently and the cache pays
      // the one-turn re-prefill. The planner still reports the cost in
      // `resendChars` if a UI ever wants to show it non-blockingly.
      const plan: LedgerPlan = planLedgerTurn(ledgerRef.current, desiredIds, docsForPlan, s.activeDocumentId)

      attachedIds = plan.ledger.entries.map(e => e.id)
      bookPrefixMessages = buildLedgerMessages(s.documents, attachedIds)
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
  }, [buildSystemPrompt, buildTail, runWholeBookBatches, forceSave])

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

    await startTurn(request.apiMessages, {
      assistantMsgId,
      originalDocContent,
      attachmentsText: request.attachmentsText,
      estimatedInputTokens: request.estimatedInputTokens
    })
  }, [chatInput, uploadedImages, layoutMode, setIsChatExpanded, setUploadedImages, planWholeBook, assembleChatRequest, startTurn])

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

    await startTurn(request.apiMessages, {
      assistantMsgId,
      originalDocContent,
      attachmentsText: request.attachmentsText,
      estimatedInputTokens: request.estimatedInputTokens
    })
  }, [layoutMode, setIsChatExpanded, planWholeBook, assembleChatRequest, startTurn])

  // Stop generation
  const handleStopGeneration = useCallback(() => {
    currentRunRef.current?.cancel()
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
    resolveWholeBookConsent
  }
}
