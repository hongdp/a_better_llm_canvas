import { useState, useRef, useCallback, useEffect } from 'react'
import { Editor } from '@tiptap/react'
import { useAppStore } from '../store/useAppStore'
import { streamLLM, type LLMMessage } from '../services/llm'
import { findResumableJob, findJobsForBubbles, resumeRemoteGeneration, abortRemoteGeneration, type PersistedGenerationJob } from '../services/remoteGeneration'
import type { StreamCallbacks } from '../types/llm'
import type { AppState } from '../store/types'
import { getTimestampId, stripIncompleteEndTag, trimIncompleteHtmlTail, isBlankContent } from '../utils/text'
import { stripChatDisplayArtifacts, buildAttachmentsLabel, wasTurnInterrupted, htmlToPlainText } from '../utils/llmContext'
import { interruptedTurnReminder, wrapReminder } from '../agent/reminders'
import { planConversationSummary, buildSummaryRequest, buildSummaryInstruction, parseSummaryReply, summaryMessages, type SummarizableMessage } from '../utils/conversationSummary'
import { planHistoryUnits, summarizableHistory, historyWindow, type HistoryEntry, type TurnTranscript } from '../utils/turnTranscripts'
import { buildChapterIndex } from '../utils/chapterIndex'
import { loadChatSummary, saveChatSummary } from '../store/chatSummaryStore'
import { replaceImagesWithPlaceholders, restoreImagePlaceholders, type ImagePlaceholderEntry } from '../utils/imagePreservation'
import { selectReferenceChapters, pinnedContextIds } from '../utils/contextSelection'
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
import { getCacheProfile, targetPromptTokens, usesResponsesApi } from '../utils/providerProfile'
import type { HistorySourceMessage } from './chat/types'
import { ASSISTANT_PLACEHOLDER, INTERRUPTED_NOTICE, RECONNECT_FAILED_NOTICE, isUnfinishedBubble, REASONING_TAIL_CHARS, REASONING_PAINT_MS, relocateResumedSelection, splitStreamingResponse, buildCompletionWarnings } from './chat/streamHandlers'
import { buildLedgerMessages, buildVolatileTail, diffTailParts, ledgerBlock, pinnedUpdates, type DynamicContextOptions, type SentTail } from './chat/dynamicContext'
import { stripDiffMarkup, diffHtml } from '../utils/diff'
import { resolveDiffMarkupInHtml } from '../utils/diffResolution'
import { replaceSelectionWithHtml } from './chat/selectionReplace'
import { AgentRun, type RunObserver } from '../agent/run'
import { ToolRegistry, toToolSpecs } from '../agent/registry'
import { DOCUMENT_WRITE_TOOLS, previewRewrite, editParagraphsTool } from '../agent/tools/documentWrites'
import { BOOK_TOOLS } from '../agent/tools/bookReads'
import { polishChapterTool } from '../agent/tools/polishChapter'
import { planTool } from '../agent/tools/plan'
import { askUserTool } from '../agent/tools/askUser'
import { analyzeInBatches, planAnalysis } from '../agent/analyzeBook'
import { polishHtml, defaultPolishModel, type PolishTransport } from '../agent/polish'
import { resolveRunSettings } from '../agent/policy'
import { chapterOutline, createRunState, restoreSeen, type ToolContext } from '../agent/types'
import { startServerRun, listServerRuns, serverRunAction, answerServerRun, steerServerRun, reportRunView, type ServerRunEvent, type ServerRunSummary, type ServerRunAction } from '../services/serverRuns'
import { onRunCatchUp, onRunEvent } from '../store/runEvents'
import { resyncBook } from '../store/bookEvents'
import { CLIENT_ID, needsTextSync } from '../store/documentSync'
import { clearPendingSave } from '../store/syncRuntime'
import { mergeVersions } from '../store/versionMerge'
import { applyRunEvent, ensureRunMessages, bubbleStillWaiting, type RunLive, runUsageDelta, type RunUsage } from './chat/serverRunEvents'
import { freshnessMarkers, recordSeen, type SeenRecord } from '../agent/freshness'
import type { AgentTurnRecord } from '../types/chat'
import type { ThinkingBlock } from '../types/llm'
import { WEB_TOOLS } from '../agent/tools/web'
import { attachmentParagraphsOf, webAvailable, webRead, webSearch } from '../services/attachments'
import { renderAttachmentIndex } from '../utils/attachments'
import {
  EMPTY_LEDGER,
  hashContent,
  planLedgerTurn,
  ledgerChapterIds,
  orderAdmissionsByStability,
  type ContextLedger,
  type LedgerPlan
} from '../utils/contextLedger'

// Per-chapter cap in the ledger. Mirrors the reference-doc cap the renderer
// applies, so the planner's cost arithmetic matches the bytes actually sent.
const MAX_LEDGER_DOC_CHARS = 20_000
// How long a rejoin may take to ATTACH — to hear anything at all from the
// stream, the server's immediate `attached` frame included. It is not a bound
// on the model: grok-4.6 was measured at 230s to its first token, and a bound
// on "first text" aborted every rejoin of a turn that was merely thinking.
const REJOIN_FIRST_EVENT_TIMEOUT_MS = 20_000

/** What a run reports into: the bubble, the chapter it started on, the cost estimate. */
interface RunInfo {
  assistantMsgId: string
  /** The user message this turn answers: its transcript is replayed only right after it (cache_continuity.md §3.1). */
  userMsgId?: string
  /** The chapter that was active when the turn was sent. */
  startId: string
  originalDocContent: string
  attachmentsText: string
  estimatedInputTokens: number
  /** Chapters whose full text the request carries (ledger, inline, active). */
  inContextIds: string[]
  /**
   * A rejoined stream (the page reloaded mid-turn): the bubble's record of
   * the steps before the one being resumed, which this run continues.
   */
  rejoined?: { prior: AgentTurnRecord | undefined }
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
/** Assistant turns whose grok reasoning items go back in the next request (the most recent ones). */
export const REASONING_HISTORY_TURNS = 8
/** Turn transcripts a tab keeps in memory (cache_continuity.md §3.1); older turns go back to their collapsed pair. */
const MAX_KEPT_TRANSCRIPTS = 60
/** The output a summary at the end of the conversation may use (server_context.SUMMARY_MAX_OUTPUT_TOKENS). */
const SUMMARY_MAX_OUTPUT_TOKENS = 8_192

const CHAT_TOOLS = new ToolRegistry([...DOCUMENT_WRITE_TOOLS, editParagraphsTool, ...BOOK_TOOLS, polishChapterTool, planTool, askUserTool, ...WEB_TOOLS])

/**
 * Whether the API server has a browser (attachments_and_web.md §2): asked
 * once per page load. web_search / web_read are offered only when it does —
 * a tool that can only fail would cost the model a step to learn that.
 */
let webStatus: Promise<boolean> | null = null
let webReady = false
function checkWebAccess(): void {
  if (webStatus) return
  webStatus = webAvailable().then(ok => { webReady = ok; return ok })
}

/** The active book's attachments, when the store holds that book's list. */
function bookAttachments(bookId: string) {
  const s = useAppStore.getState()
  return s.attachmentsBookId === bookId ? s.attachments : []
}

/** The chat text of a record's finished steps, joined as the bubble shows it. */
const recordText = (record: AgentTurnRecord | undefined) =>
  (record?.timeline ?? []).flatMap(item => item.type === 'text' ? [item.text] : []).join('\n\n')

const joinText = (...parts: string[]) => parts.map(t => t.trim()).filter(Boolean).join('\n\n')

/**
 * The record of a resumed step, added to the record of the steps before it.
 *
 * Problem: a page reload mid-turn rejoins the step in flight, and that run
 *   (one step) wrote its own record over the bubble's — a 19-chapter turn
 *   was left showing one line and "steps: 1" (2026-10-06).
 * Fix: the rejoined run continues the record it found on the bubble.
 */
function continueRecord(prior: AgentTurnRecord | undefined, next: AgentTurnRecord): AgentTurnRecord {
  if (!prior) return next
  const touched = [...prior.touched]
  for (const t of next.touched) {
    const i = touched.findIndex(p => p.documentId === t.documentId)
    if (i === -1) touched.push(t)
    else touched[i] = { ...touched[i], changes: touched[i].changes + t.changes, failed: touched[i].failed + t.failed }
  }
  return {
    ...next,
    steps: prior.steps + next.steps,
    trace: [...prior.trace, ...next.trace],
    touched,
    timeline: [...(prior.timeline ?? []), ...(next.timeline ?? [])],
    prefix: prior.prefix ?? next.prefix
  }
}

/**
 * One compact line telling the model what a past turn did with its tools.
 * Tool exchanges are not replayed across turns (spec D4), and a chapter read
 * last turn is not carried either — only pinned chapters ride along
 * (pinned_context.md) — but the model should know it read or changed them.
 */
function agentHistoryNote(m: HistorySourceMessage): string {
  const trace = m.role === 'assistant' ? m.agent?.trace : undefined
  if (!trace?.length) return ''
  const line = trace.join('; ')
  return `\n\n[Tools used in this turn: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}]`
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

/** The stored text of the chapter on screen. */
const storedOpen = (): string => {
  const st = useAppStore.getState()
  return st.documents.find(d => d.id === st.activeDocumentId)?.content ?? ''
}

/** A bubble whose turn runs on the server: the run list settles it, not the job list. */
const isServerRunBubble = (m: { agent?: { run?: { status: string } } }) =>
  !!m.agent?.run && (m.agent.run.status === 'queued' || m.agent.run.status === 'running' || m.agent.run.status === 'paused')

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
  const unfinished = s.messages.filter(m => m.role === 'assistant' && isUnfinishedBubble(m.content) && !isServerRunBubble(m))
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

/**
 * The chapters whose whole current text this request carries — the ledger
 * renders a chapter's plain text up to the per-chapter cap — by the hash of
 * their accepted reading (RunState.textSeen, agentic_chat_loop.md §0.11).
 */
export function textSeenInContext(documents: Array<{ id: string; content: string }>, inContextIds: string[]): Array<[string, string]> {
  return inContextIds.flatMap(id => {
    const doc = documents.find(d => d.id === id)
    if (!doc) return []
    const accepted = stripDiffMarkup(doc.content)
    return htmlToPlainText(accepted).length <= MAX_LEDGER_DOC_CHARS ? [[id, hashContent(accepted)] as [string, string]] : []
  })
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
  // Chapters the model read with a tool on the previous turn: scored into
  // this turn's ledger (contextSelection modelReadIds).
  const modelReadIdsRef = useRef<string[]>([])
  // What the model has already been sent, in the order it was sent. Session
  // scoped: a different book is a different prefix, and the provider's cache
  // is keyed on the token sequence, not on our bookkeeping.
  const ledgerRef = useRef<ContextLedger>(EMPTY_LEDGER)
  // What the ledger's cached prefix belongs to. A different book is different
  // text, and a different model is a different cache entirely — in both cases
  // the prefix we think is hot does not exist, so the ledger starts over.
  const ledgerScopeRef = useRef<string>('')
  // Cache continuity (docs/features/cache_continuity.md), in this tab's
  // memory: each finished turn as sent, by reply id (§3.1); what each part
  // of the tail last went out as (§3.2); the summary the ledger was frozen
  // with — null until this tab has built one (§3.3); and the tools the last
  // step offered, which a summary at the end of the conversation repeats (§3.4).
  const transcriptsRef = useRef(new Map<string, TurnTranscript>())
  const sentTailRef = useRef<SentTail>({})
  const epochSummaryRef = useRef<string | null>(null)
  const lastToolsRef = useRef<{ scope: string; tools: ReturnType<typeof toOpenAITools> | undefined } | null>(null)
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
  // The editor's HTML when a live preview first painted it: the base Stop
  // rebuilds its single undo step from. Not the turn's original — a run may
  // be previewing a chapter it created rather than the one it started on.
  const previewBaseRef = useRef<string | null>(null)
  // Which chapter the live preview is painting. The user may switch chapters
  // mid-run (agentic_chat_loop.md D2): from then on the editor shows another
  // chapter, and settling or keeping "the preview" must not touch it.
  const previewDocIdRef = useRef<string | null>(null)
  // What the run locks for the user besides the chapter its preview paints
  // (agentic_chat_loop.md §0.4): the start chapter of a selection turn, and
  // a chapter a slow write (polish) is rewriting. Everything else stays
  // editable while the run works.
  const editLockRef = useRef<{ start: string | null; writing: string | null }>({ start: null, writing: null })
  // Chat text of the run's finished steps, shown above the step in flight.
  const priorChatRef = useRef('')
  // One live progress line, for a rewrite of a chapter that is not open.
  const progressLineRef = useRef<string | null>(null)
  // The step's Anthropic thinking blocks, replayed with its tool calls.
  const thinkingRef = useRef<ThinkingBlock[]>([])
  // grok's output items of the step in flight (xAI Responses API).
  const responseItemsRef = useRef<unknown[]>([])
  // D8: what the model has been shown of each chapter (accepted-reading hash
  // and turn). Same scope as the ledger: a different book or model starts over.
  const seenRef = useRef<SeenRecord>(new Map())
  const turnCounterRef = useRef(0)
  // A server-side run this tab renders (ProviderConfig.serverRuns,
  // backend_authority.md §4.3): the ports for the editor side of its events,
  // and whether this tab sent it — only the sending tab follows the run's
  // `open` events and reports its own view; other tabs just watch.
  const serverRunRef = useRef<{ id: string; toolCtx: ToolContext; startId: string; sendingTab: boolean } | null>(null)
  // The step in flight of each server run this tab watches (chat/serverRunEvents).
  const serverLiveRef = useRef(new Map<string, RunLive>())
  /** Each server run's usage this tab has already counted into the session totals. */
  const serverUsageRef = useRef(new Map<string, RunUsage>())
  /** Count what a server run spent since its last report (the footer's Session Tokens and Last turn). */
  const countServerUsage = useCallback((runId: string, usage: ServerRunEvent['usage']) => {
    const counted = runUsageDelta(serverUsageRef.current.get(runId), usage)
    if (!counted) return
    serverUsageRef.current.set(runId, counted.total)
    const s = useAppStore.getState()
    s.addSessionTokens(counted.delta.promptTokens, counted.delta.completionTokens, counted.delta.cachedPromptTokens)
    s.setLastTurnCache({ provider: s.activeProvider, promptTokens: counted.delta.promptTokens, cachedTokens: counted.delta.cachedPromptTokens, firstTokenMs: null })
  }, [])
  // Chapters the server run locks (its `lock` events), merged into the edit lock.
  const serverLockRef = useRef<string[]>([])
  // The run's `step` means its writes are in the store; the editor converges
  // once the document event's refetch has landed, so the settle is deferred.
  const serverSettleTimerRef = useRef<number | null>(null)
  const activeBookId = useAppStore(state => state.activeBookId)
  const user = useAppStore(state => state.user)
  const activeDocumentId = useAppStore(state => state.activeDocumentId)

  /** Force the editor back to `html` after a live preview, without polluting undo. */
  /**
   * Is the chapter the preview painted still the one on screen?
   *
   * Problem: switching chapters mid-run left the preview flags set while the
   *   editor already showed the other chapter (Editor.tsx's content sync
   *   replaced the draft). Settling then wrote the FIRST chapter's HTML into
   *   the editor showing the second — and the next keystroke there would have
   *   saved it into the wrong chapter. Stop did the same into the undo stack.
   * Fix: once the open chapter is not the previewed one, nothing of the
   *   preview is on screen; settling and keeping only clear the flags.
   */
  const previewOnScreen = useCallback(() =>
    previewDocIdRef.current === null || previewDocIdRef.current === useAppStore.getState().activeDocumentId, [])

  /**
   * Tell the editor which chapters the user may not edit right now: the one
   * the live preview paints (typing there would be painted over) and those
   * in editLockRef. Only while streaming — the store clears the lock when
   * streaming stops, and a late publish must not unlock the next streamer.
   */
  const publishEditLock = useCallback(() => {
    const s = useAppStore.getState()
    if (!s.isStreaming) return
    const { start, writing } = editLockRef.current
    const preview = canvasPreviewActiveRef.current ? previewDocIdRef.current : null
    s.setEditLockedIds([...new Set([start, preview, writing, ...serverLockRef.current].filter((id): id is string => !!id))])
  }, [])

  const settleCanvasPreview = useCallback((html: string) => {
    if (!canvasPreviewActiveRef.current) return
    canvasPreviewActiveRef.current = false
    previewBaseRef.current = null
    lastCanvasPreviewRef.current = 0
    const onScreen = previewOnScreen()
    previewDocIdRef.current = null
    publishEditLock()
    if (!onScreen) return
    const editor = activeEditorRef.current
    if (editor && editor.getHTML() !== html) {
      editor.chain().setMeta('addToHistory', false).setContent(html, { emitUpdate: false }).run()
    }
  }, [previewOnScreen, publishEditLock])

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
    previewBaseRef.current = null
    lastCanvasPreviewRef.current = 0
    const onScreen = previewOnScreen()
    previewDocIdRef.current = null
    publishEditLock()
    // The user moved to another chapter: the draft is no longer on screen,
    // so there is nothing to keep — and rebuilding an undo step here would
    // put the previewed chapter's text into the open one's history.
    if (!onScreen) return null
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
  }, [previewOnScreen, publishEditLock])

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
    const settings = resolveRunSettings(s.activeProvider, s.providerConfigs[s.activeProvider])
    return {
      role: 'system',
      content: buildChatSystemPrompt({
        customInstructions: preset?.content,
        agentTools: settings.agentTools,
        continueAfterWrites: settings.policy.continueAfterWrites,
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


  // The bubble while a run streams: attachments, the chat of finished steps,
  // the step in flight, and the progress line of an off-screen rewrite.
  const paintStreamingBubble = useCallback((assistantMsgId: string, attachmentsText: string) => {
    const { chatText } = splitStreamingResponse(accumulatedTextRef.current)
    const body = [priorChatRef.current, chatText].map(t => t.trim()).filter(Boolean).join('\n\n') || 'Updating document...'
    const withProgress = progressLineRef.current ? `${body}\n\n${progressLineRef.current}` : body
    const content = attachmentsText ? `${attachmentsText}\n\n${withProgress}` : withProgress
    // Once a turn has a timeline, the bubble renders it and shows only the
    // step in flight after it (`live`); `content` keeps the whole text.
    const live = [chatText.trim(), progressLineRef.current ?? ''].filter(Boolean).join('\n\n')
    const s = useAppStore.getState()
    s.setMessages(s.messages.map(m => m.id !== assistantMsgId ? m
      : m.agent ? { ...m, content, agent: { ...m.agent, live } }
      : { ...m, content }))
  }, [])

  /**
   * One polish call (D9): the polish model of the active provider, with
   * reasoning effort left to the provider (grok-4.20 rejects the parameter)
   * and a cache key of its own — polish prompts share no prefix with the
   * conversation, so they must not compete for its cache shard.
   */
  const polishTransport: PolishTransport = useCallback((system, user, signal) => new Promise<string>((resolve, reject) => {
    const s = useAppStore.getState()
    const cfg = s.providerConfigs[s.activeProvider]
    void streamLLM(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      {
        ...cfg,
        provider: s.activeProvider,
        model: cfg.polishModel?.trim() || defaultPolishModel(s.activeProvider, cfg.model),
        reasoningEffort: 'default',
        tools: undefined,
        debug: s.debugMode,
        signal,
        conversationId: `${s.activeBookId ?? 'book'}:polish`,
        // Not a chat job: a reload must not try to stream it into a bubble.
        remoteMeta: { bookId: s.activeBookId ?? undefined, kind: 'batch' }
      },
      {
        onChunk: () => {},
        onDone: (text, usage) => {
          if (usage) useAppStore.getState().addSessionTokens(usage.promptTokens, usage.completionTokens, usage.cachedPromptTokens || 0)
          resolve(text)
        },
        onError: reject
      }
    )
  }), [])

  /**
   * The conversation summarizer (utils/conversationSummary, agentic_chat_loop
   * §0.9): the chat model, low reasoning, no tools, its own cache key. Null
   * when the call fails — the turn then falls back to the plain cut.
   */
  const summarizeConversation = useCallback(async (needs: { previousSummary: string | null; messages: SummarizableMessage[] }): Promise<string | null> => {
    const s = useAppStore.getState()
    const cfg = s.providerConfigs[s.activeProvider]
    const { system, user } = buildSummaryRequest(needs.previousSummary, needs.messages)
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        void streamLLM(
          [{ role: 'system', content: system }, { role: 'user', content: user }],
          {
            ...cfg, provider: s.activeProvider, reasoningEffort: 'low', tools: undefined, debug: s.debugMode,
            conversationId: `${s.activeBookId ?? 'book'}:summary`,
            remoteMeta: { bookId: s.activeBookId ?? undefined, kind: 'batch' }
          },
          {
            onChunk: () => {},
            onDone: (text, usage) => {
              if (usage) useAppStore.getState().addSessionTokens(usage.promptTokens, usage.completionTokens, usage.cachedPromptTokens || 0)
              resolve(text)
            },
            onError: reject
          }
        )
      })
      return parseSummaryReply(reply)
    } catch (e) {
      console.warn('[chat] Conversation summary failed; the oldest history is cut instead', e)
      return null
    }
  }, [])

  /**
   * The summary asked for at the end of the live conversation
   * (cache_continuity.md §3.4): the turn's model, reasoning effort,
   * conversation id and tools (none to be called), so it reads the
   * conversation from the cache. Throws on failure.
   */
  const summarizeLive = useCallback(async (messages: LLMMessage[], tools: ReturnType<typeof toOpenAITools> | undefined): Promise<string | null> => {
    const s = useAppStore.getState()
    const cfg = s.providerConfigs[s.activeProvider]
    const reply = await new Promise<string>((resolve, reject) => {
      void streamLLM(messages, {
        ...cfg, provider: s.activeProvider, debug: s.debugMode,
        maxOutputTokens: Math.min(cfg.maxOutputTokens ?? 16_384, SUMMARY_MAX_OUTPUT_TOKENS),
        conversationId: s.activeBookId, tools, toolChoice: tools ? 'none' as const : undefined,
        remoteMeta: { bookId: s.activeBookId ?? undefined, kind: 'batch' }
      }, {
        onChunk: () => {},
        onDone: (text, usage) => {
          if (usage) useAppStore.getState().addSessionTokens(usage.promptTokens, usage.completionTokens, usage.cachedPromptTokens || 0)
          resolve(text)
        },
        onError: reject
      })
    })
    return parseSummaryReply(reply)
  }, [])

  /** One analyze_book batch: the chat model, no tools, its own cache key. */
  const analyzeTransport = useCallback((system: string, user: string, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
    const s = useAppStore.getState()
    void streamLLM(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      {
        ...s.providerConfigs[s.activeProvider],
        provider: s.activeProvider,
        tools: undefined,
        debug: s.debugMode,
        signal,
        conversationId: `${s.activeBookId ?? 'book'}:analyze`,
        // Not a chat job: a reload must not try to stream it into a bubble.
        remoteMeta: { bookId: s.activeBookId ?? undefined, kind: 'batch' }
      },
      {
        onChunk: () => {},
        onDone: (text, usage) => {
          if (usage) useAppStore.getState().addSessionTokens(usage.promptTokens, usage.completionTokens, usage.cachedPromptTokens || 0)
          resolve(text)
        },
        onError: reject
      }
    )
  }), [])

  // The ports the turn's tools work through (src/agent/types). Built once per
  // run; every member reads refs or the store, so a resumed turn whose editor
  // mounts later still reaches the live editor.
  const buildToolContext = useCallback((info: RunInfo): ToolContext => {
    // Whether the user has opened another chapter during this run: the
    // chapter the run expects on screen is the start chapter, or the last
    // one it opened itself. Sticky — once the user has gone elsewhere the
    // view is theirs for the rest of the run.
    const view = { expected: info.startId, moved: false }
    const start = useAppStore.getState()
    const bookId = start.activeBookId
    const loggedIn = Boolean(start.user)
    if (loggedIn) checkWebAccess()
    const webOn = loggedIn && webReady && start.providerConfigs[start.activeProvider]?.webAccess !== false
    return {
    getState: useAppStore.getState,
    // The book's reference files (attachments_and_web.md §1): listed from the
    // store, their text fetched once per tab and read in bounded parts.
    ...(loggedIn ? {
      attachments: {
        list: () => bookAttachments(bookId),
        paragraphs: (id: string) => attachmentParagraphsOf(bookId, id)
      }
    } : {}),
    // The server's anonymous browser (§2); absent when off or unavailable.
    ...(webOn ? {
      web: {
        search: (query: string, maxResults: number) => webSearch(query, maxResults),
        read: (url: string) => webRead(url)
      }
    } : {}),
    // analyze_book (D7): the chat model, one call per batch, on a cache key
    // of its own — batches share no prefix with the conversation.
    analyze: {
      plan: (task, chapters) => planAnalysis(task, chapters, useAppStore.getState().activeProvider),
      run: (task, chapters, onProgress) => {
        const s = useAppStore.getState()
        return analyzeInBatches({
          task,
          chapters,
          // Batches sized under the provider's window and long-context price line (ANALYZE_BATCH_TOKENS).
          budgetChars: planAnalysis(task, chapters, s.activeProvider).batchChars,
          transport: analyzeTransport,
          // The step's controller: Stop aborts the batch in flight.
          signal: abortControllerRef.current?.signal,
          onProgress
        })
      }
    },
    polish: {
      run: (html, onProgress) => {
        const s = useAppStore.getState()
        return polishHtml(html, {
          transport: polishTransport,
          prompt: s.polishPrompt,
          writingPreset: s.customSystemPrompts.find(p => p.id === s.activeSystemPromptId)?.content,
          // The step's controller: Stop aborts the chunks in flight.
          signal: abortControllerRef.current?.signal,
          onProgress
        })
      }
    },
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
        /*
         * Problem: a run writes chapter after chapter (writes continue the
         *   turn), but the preview's flags were set once, by the first
         *   chapter. Painting the second left them naming the first: its
         *   opening frame waited out the throttle, and Stop thought nothing
         *   was on screen and kept none of the half-written chapter the user
         *   was looking at.
         * Fix: the preview is only ever asked to paint the open chapter, so
         *   a different open chapter means the preview moved — restart it
         *   there, based on that chapter's stored text (the editor may still
         *   show the previous one until it re-syncs).
         */
        const openId = useAppStore.getState().activeDocumentId
        const storedOpen = () => useAppStore.getState().documents.find(d => d.id === openId)?.content ?? ''
        const moved = canvasPreviewActiveRef.current && previewDocIdRef.current !== openId
        if (moved) {
          previewBaseRef.current = storedOpen()
          previewDocIdRef.current = openId
          lastCanvasPreviewRef.current = 0
        }
        const now = Date.now()
        if (now - lastCanvasPreviewRef.current < CANVAS_PREVIEW_THROTTLE_MS) return
        lastCanvasPreviewRef.current = now
        if (!canvasPreviewActiveRef.current) {
          // The stored text, not editor.getHTML(): right after the run opens
          // a chapter the editor may still be the previous chapter's.
          previewBaseRef.current = storedOpen()
          previewDocIdRef.current = openId
        }
        if (!canvasPreviewActiveRef.current || moved) {
          canvasPreviewActiveRef.current = true
          // Painted over from here on: the user must not type into it.
          publishEditLock()
        }
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
        // The selection lives in the chapter the turn started on. A selection
        // preview writes real transactions, so once the user has moved to
        // another chapter it would rewrite that chapter at the same offsets.
        if (useAppStore.getState().activeDocumentId !== info.startId) return
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
        // A server run commits the rewrite itself: its preview stays out of
        // the store, or this tab's next save conflicts with that commit.
        const end = replaceSelectionWithHtml(editor, from, currentEnd, restoreImagesFromPlaceholders(html), { silent: serverRunRef.current !== null })
        if (end === null) return
        selectionEndRef.current = end
        setSaveStatus('unsaved')
      },
      replaceRange: (from: number, to: number, html: string) => {
        const editor = activeEditorRef.current
        return editor ? replaceSelectionWithHtml(editor, from, to, html) : null
      },
      discardPreview: () => {
        if (!canvasPreviewActiveRef.current) return
        const st = useAppStore.getState()
        settleCanvasPreview(st.documents.find(d => d.id === st.activeDocumentId)?.content ?? '')
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
      startId: info.startId,
      original: info.originalDocContent,
      chapters: () => useAppStore.getState().documents.map(d => ({ id: d.id, title: d.title, content: d.content, summary: d.summary, loaded: d.contentLoaded !== false })),
      openId: () => useAppStore.getState().activeDocumentId,
      userMoved: () => {
        if (!view.moved && useAppStore.getState().activeDocumentId !== view.expected) view.moved = true
        return view.moved
      },
      ensureLoaded: (ids: string[]) => useAppStore.getState().ensureDocumentContents(ids),
      // The open chapter goes through updateActiveDocument so Editor.tsx's
      // content sync sees it; any other through updateDocument. Both carry
      // the blanking guard.
      commit: (id: string, html: string) => {
        const st = useAppStore.getState()
        if (id === st.activeDocumentId) st.updateActiveDocument({ content: html })
        else st.updateDocument(id, { content: html })
      },
      open: (id: string) => {
        view.expected = id
        useAppStore.getState().setActiveDocumentId(id)
      },
      create: (title: string) => useAppStore.getState().addDocument(title, '<p></p>', { activate: false }),
      rename: (id: string, title: string) => useAppStore.getState().updateDocument(id, { title }),
      remove: (id: string) => {
        const wasOpen = useAppStore.getState().activeDocumentId === id
        useAppStore.getState().deleteDocument(id)
        // Deleting the open chapter makes the store open another one. That
        // move is the run's, not the user's (see userMoved).
        if (wasOpen && !view.moved) view.expected = useAppStore.getState().activeDocumentId
      },
      snapshot: (id: string, label: string) => useAppStore.getState().createVersionSnapshot(label, id)
    },
    images: { preserve: preserveImagesWithPlaceholders, restore: restoreImagesFromPlaceholders },
    ui: {
      progress: (line: string | null) => {
        if (progressLineRef.current === line) return
        progressLineRef.current = line
        paintStreamingBubble(info.assistantMsgId, info.attachmentsText)
      },
      writing: (id: string | null) => {
        editLockRef.current = { ...editLockRef.current, writing: id }
        publishEditLock()
      }
    },
    run: restoreSeen(
      createRunState({
        startId: info.startId,
        inContext: info.inContextIds,
        startContent: info.originalDocContent,
        startOutline: chapterOutline(useAppStore.getState().documents),
        textSeen: textSeenInContext(useAppStore.getState().documents, info.inContextIds)
      }),
      info.rejoined?.prior?.seen,
      id => useAppStore.getState().documents.find(d => d.id === id && d.contentLoaded !== false)?.content
    )
    }
    // selectionRefs is a ref's `.current`, so it never changes identity — it is
    // listed only to satisfy exhaustive-deps (see the timeout note in CLAUDE.md).
  }, [preserveImagesWithPlaceholders, restoreImagesFromPlaceholders, setSaveStatus, selectionRefs, settleCanvasPreview, paintStreamingBubble, polishTransport, analyzeTransport, publishEditLock])

  // The agent record on a bubble (types/chat AgentTurnRecord): trace, steps,
  // chapters changed. Only turns that ran a tool get one.
  const setAgentRecord = useCallback((assistantMsgId: string, record: AgentTurnRecord) => {
    if (record.trace.length === 0 && record.touched.length === 0) return
    const s = useAppStore.getState()
    s.setMessages(s.messages.map(m => m.id === assistantMsgId ? { ...m, agent: record } : m))
  }, [])
  const markAgentRecord = useCallback((assistantMsgId: string, status: AgentTurnRecord['status'], suffix?: string) => {
    const s = useAppStore.getState()
    s.setMessages(s.messages.map(m => m.id === assistantMsgId && m.agent
      ? { ...m, agent: { ...m.agent, status, live: undefined, ...(suffix ? { suffix } : {}) } }
      : m))
  }, [])

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
          replace: delta.replace,
          signature: delta.signature
        })
        // Render the call as it is written: each tool previews its own
        // partial arguments (the document writes paint the editor).
        const acc = toolCallsRef.current.get(delta.index)
        if (acc) CHAT_TOOLS.get(acc.name)?.preview?.(acc.argumentsText, toolCtx)
      },
      onThinkingBlock: (block: ThinkingBlock) => {
        thinkingRef.current.push(block)
      },
      onResponseItem: (item: unknown) => {
        responseItemsRef.current.push(item)
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
        const { canvasText, canvasChapter, canvasNewChapter, selectionReplaceText, isSelectionEdit } = splitStreamingResponse(raw)
        paintStreamingBubble(assistantMsgId, attachmentsText)

        // The markup protocol's live previews, through the same ports the
        // tool calls use — routed by the canvas's chapter attribute.
        if (isSelectionEdit) {
          toolCtx.selection.relocate()
          const cleanedText = stripIncompleteEndTag(selectionReplaceText)
          if (cleanedText) toolCtx.editor.previewSelection(cleanedText)
        } else if (canvasText.trim()) {
          setSaveStatus('unsaved')
          // A new chapter is created on its first chunk, so its text streams
          // into it (documentWrites, claimNewChapter).
          previewRewrite(toolCtx, canvasNewChapter ? { create: canvasNewChapter } : canvasChapter, trimIncompleteHtmlTail(canvasText))
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

        run.stepDone({
          text: fullText,
          nativeCalls: finishToolCalls(toolCallsRef.current),
          thinking: thinkingRef.current.length > 0 ? [...thinkingRef.current] : undefined,
          responseItems: responseItemsRef.current.length > 0 ? [...responseItemsRef.current] : undefined,
          usage
        })
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
          const draft = keepCanvasPreview(previewBaseRef.current ?? originalDocContent)
          if (draft !== null) s.updateActiveDocument({ content: draft })
          // A selection rewrite previews through real transactions, so its
          // partial text is already in the store; only the note differs.
          const keptDraft = draft !== null || lastSelectionPreviewRef.current > 0

          // The bubble was last painted mid-stream ("Updating document..." or
          // a half sentence); say what happened rather than leaving it there.
          const chatText = [priorChatRef.current, splitStreamingResponse(accumulatedTextRef.current).chatText]
            .map(t => t.trim()).filter(Boolean).join('\n\n')
          const stoppedNote = keptDraft
            ? '⏹️ Stopped. The partial draft was kept in the document — Undo (Ctrl+Z) restores the previous version.'
            : '⏹️ Stopped.'
          const stoppedText = chatText.trim() ? `${chatText.trim()}\n\n${stoppedNote}` : stoppedNote
          // The timeline keeps the finished steps; the interrupted one and the
          // note follow it.
          const stoppedStep = splitStreamingResponse(accumulatedTextRef.current).chatText.trim()
          markAgentRecord(assistantMsgId, 'stopped', stoppedStep ? `${stoppedStep}\n\n${stoppedNote}` : stoppedNote)
          s.setMessages(useAppStore.getState().messages.map(m =>
            m.id === assistantMsgId
              ? { ...m, content: attachmentsText ? `${attachmentsText}\n\n${stoppedText}` : stoppedText }
              : m
          ))
          forceSave()
          return
        }

        setErrorMsg(err.message)
        markAgentRecord(assistantMsgId, 'stopped', `⚠️ Error during stream: ${err.message}`)

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

        // Put the start chapter back only if this run committed nothing to it:
        // an earlier step's write is already a reviewable diff, and an error
        // in a later step must not erase it. A selection preview did write
        // through real transactions, so it is reverted when it never landed.
        //
        // Only a selection turn wrote the store before committing: without
        // one, the stored start chapter is the original or the user's own
        // edit (it is editable mid-run then), and must not be reset.
        const latest = useAppStore.getState()
        const startKept = !!toolCtx.run.docs.get(toolCtx.document.startId)?.dirty || toolCtx.run.selectionApplied
        const selectionTurn = !!toolCtx.selection.originalText()
        if (latest.activeDocumentId === toolCtx.document.startId && !startKept && selectionTurn) {
          settleCanvasPreview(originalDocContent)
          s.updateActiveDocument({ content: originalDocContent })
        } else {
          settleCanvasPreview(latest.documents.find(d => d.id === latest.activeDocumentId)?.content ?? '')
        }
        forceSave()
      }
    }
  }, [setSaveStatus, settleCanvasPreview, keepCanvasPreview, forceSave, paintStreamingBubble, markAgentRecord])

  // How a run reports to the chat: the corrective-retry status line, and the
  // final bubble once the run is over.
  const buildRunObserver = useCallback((info: RunInfo): RunObserver => ({
    onStepExecuted: (progress) => {
      progressLineRef.current = null
      // The step's writes are in the store: its preview is over. Converge the
      // editor with what was stored (a refused rewrite leaves the old text)
      // and lift the preview's edit lock for the steps that follow.
      const st = useAppStore.getState()
      settleCanvasPreview(st.documents.find(d => d.id === st.activeDocumentId)?.content ?? '')
      const prior = info.rejoined?.prior
      priorChatRef.current = joinText(recordText(prior), progress.chatText)
      setAgentRecord(info.assistantMsgId, continueRecord(prior, {
        status: 'running',
        steps: progress.steps,
        trace: progress.trace,
        touched: progress.touched,
        timeline: progress.timeline,
        seen: progress.seen,
        plan: progress.plan.length > 0 ? progress.plan : undefined,
        prefix: info.attachmentsText || undefined
      }))
    },
    onCorrective: (failure, attempt, max) => {
      // The stored text of the previewed chapter, not the turn's original:
      // the preview may be on a chapter the run created, or on one an
      // earlier step already wrote.
      const st = useAppStore.getState()
      settleCanvasPreview(st.documents.find(d => d.id === st.activeDocumentId)?.content ?? info.originalDocContent)
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
      priorChatRef.current = ''
      progressLineRef.current = null
      // The record is completed below, once the warnings are known.
      const status: AgentTurnRecord['status'] =
        summary.endReason === 'step_limit' ? 'step_limit' : summary.endReason === 'cancelled' ? 'stopped' : 'done'
      // Chapters the model chose to read are the conversation's subject now:
      // the continuity signal admits them into next turn's cached ledger,
      // instead of the model paying a read step for them again (D4, D7).
      modelReadIdsRef.current = summary.readIds
      // The turn as sent, for the next one to replay (cache_continuity.md §3.1).
      // A rejoined run never saw the request it continues: nothing to keep.
      if (info.userMsgId && !info.rejoined && summary.transcript.length > 0) {
        const kept = transcriptsRef.current
        kept.set(info.assistantMsgId, { userMessageId: info.userMsgId, messages: summary.transcript })
        while (kept.size > MAX_KEPT_TRANSCRIPTS) kept.delete(kept.keys().next().value as string)
      }
      // …and the model has seen their current bytes (D8).
      const turn = turnCounterRef.current
      for (const id of [...summary.readIds, ...summary.touched.map(t => t.documentId)]) {
        const doc = s.documents.find(d => d.id === id)
        if (doc) recordSeen(seenRef.current, id, doc.content, turn)
      }

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

      const prior = info.rejoined?.prior
      const chatText = joinText(recordText(prior), summary.chatText) || 'Document updated successfully.'
      // A rejoined step cannot continue its run (there is no request to
      // re-issue). When the run would have gone on, say why it stopped —
      // otherwise a reload mid-series looks like the model giving up.
      const wouldContinue = summary.endReason === 'step_limit' ||
        (summary.endReason === 'writes_done' && resolveRunSettings(s.activeProvider, s.providerConfigs[s.activeProvider]).policy.continueAfterWrites)
      const limitNote = info.rejoined
        ? (wouldContinue ? '\n\nℹ️ The page reloaded during this turn, so it stopped after the step that was running. Reply "continue" to go on.' : '')
        : summary.endReason === 'step_limit'
          ? `\n\nℹ️ This turn stopped at its step limit (${summary.steps} steps). Reply "continue" to let it go on, or raise the limit in Settings.`
          : ''
      const displayChatText = (info.attachmentsText ? `${info.attachmentsText}\n\n${chatText}` : chatText) + warningNote + limitNote
      // The final step's reasoning items, kept with the message so later
      // turns can send them back (ChatMessage.reasoningItems). Only the
      // reasoning: a message item would put raw markup into history, and a
      // function_call needs its output beside it.
      const reasoningItems = responseItemsRef.current.filter(item =>
        !!item && typeof item === 'object' && (item as { type?: unknown }).type === 'reasoning')
      s.setMessages(useAppStore.getState().messages.map(m =>
        m.id === info.assistantMsgId
          ? { ...m, content: displayChatText, ...(reasoningItems.length > 0 ? { reasoningItems } : {}) }
          : m
      ))
      setAgentRecord(info.assistantMsgId, continueRecord(prior, {
        status: info.rejoined && wouldContinue ? 'stopped' : status,
        steps: summary.steps,
        trace: summary.trace,
        touched: summary.touched,
        timeline: summary.timeline,
        plan: summary.plan.length > 0 ? summary.plan : undefined,
        // A turn that ended asking: the question shows as choices under the
        // bubble (RunControls); the user's pick is the next message.
        question: summary.question ?? undefined,
        prefix: info.attachmentsText || undefined,
        suffix: (warningNote + limitNote).trim() || undefined
      }))

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
  }), [settleCanvasPreview, forceSave, setAgentRecord])

  // ── Server-side runs (backend_authority.md §4.3) ─────────────────────
  // With `serverRuns` on, the turn is posted to the API process, which runs
  // the loop and writes the book; this tab renders the run's events: the
  // bubble through chat/serverRunEvents, the editor through the same ports a
  // local run uses (previews, locks, opening chapters).

  /** On for this provider, and there is a server to run turns. */
  const serverRunsEnabled = useCallback(() => {
    const s = useAppStore.getState()
    return !!s.user && !!s.activeBookId && s.providerConfigs[s.activeProvider]?.serverRuns === true
  }, [])

  /** This tab renders `run` from now on: ports for its previews, the streaming flag, the lock. */
  const attachServerRun = useCallback((run: ServerRunSummary) => {
    const s = useAppStore.getState()
    const startId = run.activeDocumentId || s.activeDocumentId
    const original = s.documents.find(d => d.id === startId)?.content ?? ''
    // A selection rewrite previews by relocating the selected TEXT, as a
    // rejoined turn does: the range never leaves the tab that made it.
    originalSelectedTextRef.current = run.selectedText ?? ''
    pendingSelectionTextRef.current = run.selectedText || null
    selectionRangeRef.current = null
    selectionEndRef.current = null
    lastSelectionPreviewRef.current = 0
    const toolCtx = buildToolContext({
      assistantMsgId: run.assistantMessageId ?? '', startId, originalDocContent: original,
      attachmentsText: run.record?.prefix ?? '', estimatedInputTokens: 0, inContextIds: []
    })
    serverRunRef.current = { id: run.id, toolCtx, startId, sendingTab: run.clientId === CLIENT_ID }
    if (run.status === 'running') {
      s.setStreaming(true)
      editLockRef.current = { start: run.selectedText ? startId : null, writing: null }
      publishEditLock()
    }
  }, [buildToolContext, publishEditLock])

  /** Post the turn to the server. The bubble then follows the run's events. */
  const startServerTurn = useCallback(async (opts: {
    promptText: string
    images?: string[]
    historySource: HistorySourceMessage[]
    userMsgId: string
    assistantMsgId: string
  }) => {
    const s = useAppStore.getState()
    const cfg = s.providerConfigs[s.activeProvider]
    const preset = s.customSystemPrompts.find(p => p.id === s.activeSystemPromptId)
    try {
      // The server builds the request from the stored book, and the save
      // behind an edit is debounced: an edit typed in the seconds before
      // the send would be missing from the prompt, and the run's write on
      // the stale chapter would then race this tab's save for the revision.
      if (s.documents.some(d => d.contentLoaded !== false && needsTextSync(d))) {
        clearPendingSave()
        await s.syncToServer()
      }
      const { run, position } = await startServerRun(s.activeBookId as string, {
        prompt: opts.promptText,
        images: opts.images,
        provider: s.activeProvider,
        config: {
          apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl, maxOutputTokens: cfg.maxOutputTokens,
          geminiSafetySettings: cfg.geminiSafetySettings, reasoningEffort: cfg.reasoningEffort, documentProtocol: cfg.documentProtocol,
          agentTools: cfg.agentTools, agentMaxSteps: cfg.agentMaxSteps, continueAfterWrites: cfg.continueAfterWrites,
          polishModel: cfg.polishModel, runTokenBudget: cfg.runTokenBudget, longReasoningReminderTokens: cfg.longReasoningReminderTokens,
          webAccess: cfg.webAccess
        },
        activeDocumentId: s.activeDocumentId,
        selectedText: selectedText || undefined,
        history: opts.historySource.filter(m => m.id !== 'welcome').map(m => ({
          id: m.id, role: m.role, content: m.content, images: m.images, agent: m.agent, reasoningItems: m.reasoningItems
        })),
        userMessageId: opts.userMsgId,
        assistantMessageId: opts.assistantMsgId,
        customInstructions: preset?.content,
        polishPrompt: s.polishPrompt,
        contextWindowTokens: s.discoveredContextWindows[cfg.model],
        clientId: CLIENT_ID
      })
      const latest = useAppStore.getState()
      latest.setMessages(applyRunEvent(latest.messages, { type: 'run', kind: run.status === 'queued' ? 'queued' : 'started', runId: run.id, run, position }, serverLiveRef.current))
      // The run's first events may have arrived before this response.
      if (run.status === 'running' && serverRunRef.current?.id !== run.id) attachServerRun(run)
      forceSave()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setErrorMsg(message)
      const latest = useAppStore.getState()
      latest.setStreaming(false)
      latest.setMessages(latest.messages.map(m => m.id === opts.assistantMsgId ? { ...m, content: `⚠️ ${message}` } : m))
    }
  }, [selectedText, attachServerRun, forceSave])

  /** Settle the preview once the run's write has reached the store (the document event's refetch). */
  const settleServerPreviewSoon = useCallback(() => {
    if (serverSettleTimerRef.current !== null) window.clearTimeout(serverSettleTimerRef.current)
    serverSettleTimerRef.current = window.setTimeout(() => {
      serverSettleTimerRef.current = null
      settleCanvasPreview(storedOpen())
    }, 400)
  }, [settleCanvasPreview])

  /** One `run.*` event, rendered: the bubble through the reducer, the editor through the ports. */
  const handleRunEvent = useCallback(async (event: ServerRunEvent) => {
    const s = useAppStore.getState()
    const current = serverRunRef.current
    const mine = current?.id === event.runId
    switch (event.kind) {
      case 'queued':
      case 'started': {
        if (!event.run) return
        s.setMessages(applyRunEvent(s.messages, event, serverLiveRef.current))
        if (event.kind === 'started') {
          if (event.run.status === 'running' && !mine) attachServerRun(event.run)
          reasoningTailRef.current = ''
          s.setStreamingReasoning('')
          turnStartedAtRef.current = Date.now()
          firstTokenAtRef.current = 0
        }
        return
      }
      case 'step_started': {
        s.setMessages(applyRunEvent(s.messages, event, serverLiveRef.current))
        turnStartedAtRef.current = Date.now()
        firstTokenAtRef.current = 0
        reasoningTailRef.current = ''
        s.setStreamingReasoning('')
        return
      }
      case 'reasoning': {
        if (!mine) return
        if (firstTokenAtRef.current === 0) firstTokenAtRef.current = Date.now()
        reasoningTailRef.current = (reasoningTailRef.current + (event.text ?? '')).slice(-REASONING_TAIL_CHARS)
        const now = Date.now()
        if (now - lastReasoningPaintRef.current < REASONING_PAINT_MS) return
        lastReasoningPaintRef.current = now
        s.setStreamingReasoning(reasoningTailRef.current)
        return
      }
      case 'delta':
      case 'progress':
      case 'corrective': {
        if (event.kind === 'delta') {
          if (firstTokenAtRef.current === 0) firstTokenAtRef.current = Date.now()
          if (reasoningTailRef.current) {
            reasoningTailRef.current = ''
            s.setStreamingReasoning('')
          }
        }
        if (event.kind === 'corrective' && mine) settleCanvasPreview(storedOpen())
        s.setMessages(applyRunEvent(s.messages, event, serverLiveRef.current))
        return
      }
      case 'preview': {
        if (!mine || !current) return
        if (event.html === null || event.html === undefined) {
          if (event.settled) settleServerPreviewSoon()
          else settleCanvasPreview(storedOpen())
          return
        }
        if (event.documentId !== s.activeDocumentId) return
        // The user typed here meanwhile: never paint over their text.
        if (s.documents.find(d => d.id === event.documentId)?.unsynced) return
        setSaveStatus('unsaved')
        current.toolCtx.editor.previewDocument(event.html)
        return
      }
      case 'preview_selection': {
        if (!mine || !current || !event.html) return
        current.toolCtx.selection.relocate()
        current.toolCtx.editor.previewSelection(event.html)
        return
      }
      case 'lock': {
        if (!mine) return
        serverLockRef.current = event.documentIds ?? []
        publishEditLock()
        return
      }
      case 'open': {
        if (!mine || !current?.sendingTab || !event.documentId) return
        if (!s.documents.some(d => d.id === event.documentId) && s.activeBookId) await resyncBook({ bookId: s.activeBookId })
        const latest = useAppStore.getState()
        if (latest.documents.some(d => d.id === event.documentId)) latest.setActiveDocumentId(event.documentId)
        return
      }
      case 'step': {
        countServerUsage(event.runId, event.usage)
        if (mine) settleServerPreviewSoon()
        s.setMessages(applyRunEvent(s.messages, event, serverLiveRef.current))
        forceSave()
        return
      }
      case 'paused':
      case 'finished': {
        if (event.kind === 'finished') {
          countServerUsage(event.runId, event.result?.usage)
          serverUsageRef.current.delete(event.runId)
        }
        if (mine) {
          settleCanvasPreview(storedOpen())
          serverLockRef.current = []
          serverRunRef.current = null
          reasoningTailRef.current = ''
          s.setStreamingReasoning('')
        }
        s.setStreaming(false)
        const latest = useAppStore.getState()
        latest.setMessages(applyRunEvent(latest.messages, event, serverLiveRef.current))
        // Versions the run took before changing a chapter (metadata; the text loads on demand).
        const snapshots = event.result?.snapshots
        if (event.kind === 'finished' && snapshots?.length && latest.activeBookId) {
          useAppStore.setState({ versions: mergeVersions(useAppStore.getState().versions, snapshots, latest.activeBookId) })
        }
        forceSave()
        return
      }
      default:
        return
    }
  }, [attachServerRun, settleCanvasPreview, settleServerPreviewSoon, publishEditLock, forceSave, setSaveStatus, countServerUsage])

  useEffect(() => onRunEvent(event => { void handleRunEvent(event) }), [handleRunEvent])

  /**
   * The book's runs, on load and on every book switch: a queued, running or
   * paused run gets its bubble (created when another device sent it) and its
   * state; a run that finished while this tab was away settles its bubble.
   */
  const reconcileServerRuns = useCallback(async () => {
    const s0 = useAppStore.getState()
    if (!s0.user || !s0.activeBookId) return
    const bookId = s0.activeBookId
    let listed: Awaited<ReturnType<typeof listServerRuns>>
    try {
      listed = await listServerRuns(bookId)
    } catch {
      return
    }
    if (listed.runs.length === 0) return
    await waitForStore(state => state.messages.length > 0, 15_000)
    if (useAppStore.getState().activeBookId !== bookId) return
    for (const run of listed.runs) {
      const s = useAppStore.getState()
      // The run this tab follows ended or paused while its events were missed:
      // settle it the way the live event would, so the bubble, the streaming
      // flag, the reasoning timer and the edit locks all end together.
      if (serverRunRef.current?.id === run.id && (run.status === 'paused' || run.status === 'done' || run.status === 'stopped' || run.status === 'error')) {
        await handleRunEvent(run.status === 'paused'
          ? { type: 'run', kind: 'paused', runId: run.id, run, record: run.record, pause: run.pause ?? undefined }
          : { type: 'run', kind: 'finished', runId: run.id, run, status: run.status, result: run.result ?? undefined })
        continue
      }
      if (run.status === 'queued' || run.status === 'running' || run.status === 'paused') {
        const kind = run.status === 'queued' ? 'queued' : run.status === 'paused' ? 'paused' : 'started'
        let messages = applyRunEvent(ensureRunMessages(s.messages, run), { type: 'run', kind, runId: run.id, run, record: run.record, pause: run.pause ?? undefined }, serverLiveRef.current)
        if (run.status === 'running' && run.liveText) {
          serverLiveRef.current.set(run.id, { text: run.liveText, progress: null })
          messages = applyRunEvent(messages, { type: 'run', kind: 'delta', runId: run.id, text: '' }, serverLiveRef.current)
        }
        s.setMessages(messages)
        if (run.status === 'running' && serverRunRef.current?.id !== run.id) {
          attachServerRun(run)
          if (run.liveReasoning) s.setStreamingReasoning(run.liveReasoning.slice(-REASONING_TAIL_CHARS))
        }
      } else if (run.result && run.assistantMessageId) {
        const bubble = s.messages.find(m => m.id === run.assistantMessageId)
        if (bubble && bubbleStillWaiting(bubble)) {
          s.setMessages(applyRunEvent(s.messages, { type: 'run', kind: 'finished', runId: run.id, run, status: run.status, result: run.result }, serverLiveRef.current))
        }
      }
    }
  }, [attachServerRun, handleRunEvent])
  useEffect(() => { void reconcileServerRuns() }, [reconcileServerRuns, activeBookId, user])
  // Events may have been missed (the stream dropped, or the page was in the background): re-read the runs.
  useEffect(() => onRunCatchUp(() => { void reconcileServerRuns() }), [reconcileServerRuns])
  // Ask once whether the server can browse, before the first turn's tools are fixed.
  useEffect(() => { if (user) checkWebAccess() }, [user])

  // The sending tab tells the run where the user is (agentic_chat_loop.md
  // §0.4: once they move, the run stops changing the view).
  useEffect(() => {
    const current = serverRunRef.current
    const s = useAppStore.getState()
    if (!current?.sendingTab || !s.activeBookId || !s.isStreaming) return
    void reportRunView(s.activeBookId, current.id, activeDocumentId)
  }, [activeDocumentId])

  /** The user's answer to a server run paused on `ask_user` (components/RunControls). */
  const handleRunAnswer = useCallback(async (runId: string, answer: string) => {
    const s = useAppStore.getState()
    if (!s.activeBookId) return
    try {
      await answerServerRun(s.activeBookId, runId, answer)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /** Queue and pause controls under a bubble (components/RunControls). */
  const handleRunAction = useCallback(async (runId: string, action: ServerRunAction) => {
    const s = useAppStore.getState()
    if (!s.activeBookId) return
    try {
      await serverRunAction(s.activeBookId, runId, action)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // One model call of a run: per-step resets, the abort controller, the
  // selection capture, and the request with the tools this step offers.
  const streamStep = useCallback(async (messages: LLMMessage[], stepIndex: number, rc: StreamRenderContext, final: boolean) => {
    const s = useAppStore.getState()

    // Clock for time-to-first-token. Reset per step, corrective ones
    // included: each one pays its own prefill.
    turnStartedAtRef.current = Date.now()
    firstTokenAtRef.current = 0

    // Start each step with no leftover tool calls or thinking on screen.
    toolCallsRef.current = new Map()
    thinkingRef.current = []
    responseItemsRef.current = []
    accumulatedTextRef.current = ''
    progressLineRef.current = null
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

    // Capture the selection once, at the run's first step. Later steps keep
    // it: the editor's selection moves when a rewrite lands, and the tools
    // the run offers (replace_selection among them) must not change mid-run.
    if (stepIndex > 0) {
      // keep the range captured at step 0
    } else if (activeEditor && selectedText) {
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
    // A selection turn locks its chapter for the whole run (the selection
    // preview writes it through real transactions); otherwise the start
    // chapter is locked only while a preview paints it.
    if (stepIndex === 0) {
      editLockRef.current = { start: originalSelectedTextRef.current ? rc.startId : null, writing: null }
      publishEditLock()
    }

    // Offered AFTER the selection capture: replace_selection exists only
    // when there is a selection to replace. On the markup protocol the
    // writes are tags, so nothing is sent unless a non-write tool exists —
    // offering both invites the model to mix them, and the tag parser then
    // sees a reply with no tags.
    const offered = rc.run.offeredTools()
    const tools = offered.length > 0 ? toOpenAITools(toToolSpecs(offered)) : undefined
    lastToolsRef.current = { scope: ledgerScopeRef.current, tools }

    try {
      await streamLLM(
        messages,
        {
          ...s.providerConfigs[s.activeProvider],
          provider: s.activeProvider,
          debug: s.debugMode,
          signal,
          conversationId: s.activeBookId,
          tools,
          // The last step the budget allows: tools stay in the request (earlier
          // calls reference them), but no new call is allowed (D5).
          toolChoice: final && offered.length > 0 ? 'none' as const : undefined,
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
  }, [activeEditor, selectedText, buildStreamCallbacks, publishEditLock])

  /**
   * Build the run for one turn. `canContinue` is false for a reader that has
   * no request to re-issue (the rejoin path): no corrective step, no
   * follow-up step, and no "gave up" warning either.
   */
  const createRun = useCallback((info: RunInfo, initialMessages: LLMMessage[], canContinue: boolean): StreamRenderContext => {
    const s = useAppStore.getState()
    const toolCtx = buildToolContext(info)
    const rcRef: { current: StreamRenderContext | null } = { current: null }
    // Until the first step knows whether there is a selection, the start
    // chapter is locked. A rejoined stream never runs that step and keeps it.
    editLockRef.current = { start: info.startId, writing: null }
    publishEditLock()
    const settings = resolveRunSettings(s.activeProvider, s.providerConfigs[s.activeProvider], canContinue)
    // A rejoined step shows below the text of the steps before it.
    priorChatRef.current = recordText(info.rejoined?.prior)
    const run = new AgentRun({
      registry: CHAT_TOOLS,
      ctx: toolCtx,
      writeProtocol: resolveDocumentProtocol(s.activeProvider, s.providerConfigs[s.activeProvider]?.documentProtocol),
      driver: (messages, stepIndex, opts) => streamStep(messages, stepIndex, rcRef.current as StreamRenderContext, opts.final),
      observer: buildRunObserver(info),
      budgets: settings.budgets,
      policy: settings.policy,
      agentTools: settings.agentTools,
      canContinue,
      initialMessages,
      longReasoningTokens: s.providerConfigs[s.activeProvider]?.longReasoningReminderTokens ?? 0,
      // The prompt a step may use: the window's target less the output
      // (agent/runCompaction elides old read results past it).
      promptTokenLimit: targetPromptTokens(
        getCacheProfile(s.activeProvider),
        resolveContextWindowTokens(s.activeProvider, s.providerConfigs[s.activeProvider]?.model ?? '', s.discoveredContextWindows[s.providerConfigs[s.activeProvider]?.model ?? ''])
      ) - (s.providerConfigs[s.activeProvider]?.maxOutputTokens ?? 16_384)
    })
    rcRef.current = { ...info, run, toolCtx }
    currentRunRef.current = run
    return rcRef.current
  }, [buildToolContext, buildRunObserver, streamStep, publishEditLock])

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
      // A rejoin skips streamStep, so the per-step reset lives here too. A
      // resume replays every thinking block from the start, so the collected
      // ones must start empty (or they would be replayed twice).
      toolCallsRef.current = new Map()
      thinkingRef.current = []
      responseItemsRef.current = []
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
        {
          assistantMsgId,
          startId: reloaded.activeDocumentId,
          originalDocContent,
          attachmentsText: '',
          estimatedInputTokens: 0,
          inContextIds: [],
          rejoined: { prior: useAppStore.getState().messages.find(m => m.id === assistantMsgId)?.agent }
        },
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
  }): Promise<{
    apiMessages: LLMMessage[]
    attachmentsText: string
    estimatedInputTokens: number
    /** Chapters whose full text this request carries — the run's `inContext`. */
    inContextIds: string[]
  } | null> => {
    const { promptText, images, historySource } = opts
    // With the agent tools on, the pinned chapters ride along
    // (docs/features/pinned_context.md): their text must be here first.
    const pre = useAppStore.getState()
    const agentContext = resolveRunSettings(pre.activeProvider, pre.providerConfigs[pre.activeProvider]).agentTools
    const pinnedUnloaded = pre.documents.filter(d => d.pinned && d.contentLoaded === false && d.id !== pre.activeDocumentId).map(d => d.id)
    if (agentContext && pinnedUnloaded.length > 0) await pre.ensureDocumentContents(pinnedUnloaded)
    const s = useAppStore.getState()

    const ledgerScope = `${s.activeBookId ?? ''}|${s.activeProvider}|${s.providerConfigs[s.activeProvider]?.model ?? ''}`
    if (ledgerScope !== ledgerScopeRef.current) {
      ledgerRef.current = EMPTY_LEDGER
      ledgerScopeRef.current = ledgerScope
      seenRef.current = new Map()
      transcriptsRef.current = new Map()
      sentTailRef.current = {}
      epochSummaryRef.current = null
    }

    /*
     * Which chapters ride ahead of the history.
     * Agent tools on: the ones the writer pinned, nothing else — the model
     *   reads the rest with its tools (pinned_context.md: of 125 chapters the
     *   scorer had attached across 39 turns, 19 were read or written, and its
     *   churn cut the cache to 8%).
     * Tools off: the scorer's prefetch, as before — that model cannot read.
     */
    const selection = agentContext ? null : selectReferenceChapters({
      promptText,
      recentHistory: historySource.filter(m => m.id !== 'welcome').map(m => m.content),
      documents: s.documents,
      activeDocumentId: s.activeDocumentId,
      previousAttachedIds: previousAttachedIdsRef.current,
      modelReadIds: modelReadIdsRef.current,
      ledgerIds: ledgerRef.current.entries.map(e => e.id)
    })
    if (selection) previousAttachedIdsRef.current = selection.attachedIds

    const systemPrompt = buildSystemPrompt()

    // Prompt layout: the stable prefix is what makes provider prompt caching
    // effective turn over turn.
    // History is budgeted against the MODEL's window, not a flat number. A
    // 262144-token local endpoint was being trimmed at ~20k tokens of Chinese
    // while a 32k model would have been handed a prompt it must silently
    // truncate — and truncation hits the FRONT of the prompt, which is exactly
    // the cached prefix. `estimateTokens` counts CJK at ~1 token/char: the
    // length/4 rule used elsewhere underestimates Chinese four-fold.
    // grok keeps what it reasoned in earlier turns: the last few assistant
    // messages carry their reasoning items (replayed ahead of their text).
    // Few, because each is ciphertext the size of the reasoning it encodes.
    const withReasoning = new Set(
      historySource.filter(m => m.role === 'assistant' && m.reasoningItems?.length).slice(-REASONING_HISTORY_TURNS).map(m => m.id))
    const entries: HistoryEntry[] = historySource
      .filter(m => m.id !== 'welcome')
      .map(m => ({
        id: m.id,
        role: m.role,
        content: stripChatDisplayArtifacts(m.content) + agentHistoryNote(m),
        images: m.images,
        ...(usesResponsesApi(s.activeProvider, s.providerConfigs[s.activeProvider]?.baseUrl ?? '') && withReasoning.has(m.id) ? { responseItems: m.reasoningItems } : {})
      }))
    // With the agent tools on, the request extends the previous turn's
    // (cache_continuity.md): earlier turns replay as they were sent, the
    // ledger stays frozen until the summary changes, and the tail sends only
    // what changed since the copy the model has.
    const runSettings = resolveRunSettings(s.activeProvider, s.providerConfigs[s.activeProvider])
    const continuity = runSettings.agentTools
    const replay: Record<string, TurnTranscript> = continuity ? Object.fromEntries(transcriptsRef.current) : {}
    const units = planHistoryUnits(entries, replay)
    const activeDocContent = s.documents.find(d => d.id === s.activeDocumentId)?.content ?? ''
    // Budget against the provider's price cliff where it has one, not just its
    // window: xAI's long-context tier counts CACHED tokens toward the
    // threshold and doubles every rate above it, so a well-cached conversation
    // can cross the line with nothing looking wrong.
    const cacheProfile = getCacheProfile(s.activeProvider)
    const maxOutputTokens = s.providerConfigs[s.activeProvider]?.maxOutputTokens ?? 16_384
    const windowTokens = resolveContextWindowTokens(
      s.activeProvider,
      s.providerConfigs[s.activeProvider]?.model ?? '',
      s.discoveredContextWindows[s.providerConfigs[s.activeProvider]?.model ?? '']
    )
    const historyBudget = historyBudgetChars({
      contextTokens: targetPromptTokens(cacheProfile, windowTokens),
      maxOutputTokens,
      // Everything else this turn sends: system prompt, the ledger block and
      // the volatile tail. The ledger is not built yet, so its members are
      // priced from the documents they will render.
      fixedTokens:
        estimateTokens(systemPrompt.content) +
        estimateTokens(activeDocContent) +
        ledgerRef.current.entries.reduce((sum, e) => sum + Math.ceil(e.chars * 0.9), 0),
      cjkRatio: cjkRatioOf(entries.map(m => m.content).join('') || activeDocContent)
    })
    // History past the budget is summarized, not cut (agentic_chat_loop.md
    // §0.9): the stored note serves while its cut still fits, a call refreshes
    // it when it does not, and a failed call leaves the plain cut for this turn.
    const stored = s.activeBookId ? loadChatSummary(s.activeBookId) : null
    let summaryPlan = planConversationSummary(summarizableHistory(entries, units, replay), historyBudget, stored)
    if (summaryPlan.needs) {
      let made: string | null = null
      // The conversation as the last request carried it, then the instruction
      // (cache_continuity.md §3.4) — when this tab sent that request (its
      // ledger and tools are known here) and it fits the window.
      const tools = lastToolsRef.current?.scope === ledgerScopeRef.current ? lastToolsRef.current : null
      if (continuity && tools && epochSummaryRef.current !== null) {
        const prior = summaryPlan.needs.previousSummary
        const priorAt = prior && stored ? Math.max(0, entries.findIndex(m => m.id === stored.upToId)) : 0
        const live: LLMMessage[] = [
          systemPrompt,
          ...buildLedgerMessages(s.documents, ledgerRef.current.entries, undefined, { agentTools: true }),
          ...(prior ? summaryMessages(prior) : []),
          ...historyWindow(entries, units, replay, priorAt, null).messages,
          { role: 'user', content: buildSummaryInstruction(entries[summaryPlan.cutIndex]?.content ?? null, Boolean(prior)) }
        ]
        const size = live.reduce((sum, m) => sum + estimateTokens(m.content) + (m.toolCalls ?? []).reduce((t, c) => t + estimateTokens(c.argumentsText), 0), 0)
        if (size <= Math.floor(windowTokens * 0.95) - Math.min(maxOutputTokens, SUMMARY_MAX_OUTPUT_TOKENS)) {
          try {
            made = await summarizeLive(live, tools.tools)
          } catch (e) {
            console.warn('[chat] Conversation summary failed; the oldest history is cut instead', e)
          }
        } else {
          made = await summarizeConversation(summaryPlan.needs)
        }
      } else {
        made = await summarizeConversation(summaryPlan.needs)
      }
      if (made && summaryPlan.upToId && s.activeBookId) {
        saveChatSummary(s.activeBookId, { upToId: summaryPlan.upToId, text: made })
        summaryPlan = { ...summaryPlan, summary: made, needs: null }
      } else {
        summaryPlan = { cutIndex: 0, summary: null, needs: null, upToId: null }
      }
    }
    const summaryPrefix = summaryPlan.summary ? summaryMessages(summaryPlan.summary) : []
    const window = historyWindow(entries, units, replay, summaryPlan.summary ? summaryPlan.cutIndex : 0, summaryPlan.summary ? null : historyBudget)
    const historyMessages: LLMMessage[] = window.messages
    if (historyMessages.length > 0) {
      historyMessages[historyMessages.length - 1].cacheHint = true
    }

    // The agentic loop's view of the index (D8): which chapters this request
    // carries in full, which the model saw before and whether they changed.
    turnCounterRef.current += 1

    const autoIds = selection?.autoIds ?? []
    // Cache-first assembly: chapters go into an append-only block ahead of
    // the history, so an unchanged set costs nothing to re-send. New
    // admissions are ordered most-stable-first, because removing an entry
    // re-sends everything after it — so the documents the writer revises
    // constantly (the outline) belong at the END, where invalidating them
    // costs only themselves. See docs/features/cache_first_context.md.
    const bookOrder = s.documents.map(d => d.id)
    // Hashed on the ACCEPTED reading, which is what the ledger renders:
    // accepting a pending diff changes the HTML but not what the model
    // reads, and must not cost a re-send (see ledgerBlock).
    const docsForPlan = s.documents.map(d => {
      const accepted = stripDiffMarkup(d.content)
      return { id: d.id, chars: Math.min(accepted.length, MAX_LEDGER_DOC_CHARS), hash: hashContent(accepted) }
    })
    const hashOf = new Map(docsForPlan.map(d => [d.id, d.hash]))
    const wanted = selection
      ? selection.attachedIds
      // Budgeted on the text the ledger renders, not the HTML: a formatted
      // character card is twice its text in HTML, and counted as HTML four
      // pins used 80% of the budget for 25k characters of text.
      : pinnedContextIds(s.documents.map(d => {
        const pinned = Boolean(d.pinned) && d.contentLoaded !== false
        return { id: d.id, pinned, chars: pinned ? Math.min(htmlToPlainText(stripDiffMarkup(d.content)).length, MAX_LEDGER_DOC_CHARS) : 0 }
      }), s.activeDocumentId)
    // A pinned chapter the writer has open keeps its place in the ledger
    // (pinned_context.md §2.1): opening and closing it used to cost two misses.
    const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
    const keepIds = !selection && activeDoc?.pinned ? [activeDoc.id] : []
    const desiredIds = orderAdmissionsByStability(
      wanted,
      s.documents.map(d => ({ id: d.id, updatedAt: d.updatedAt })),
      bookOrder,
      s.activeDocumentId
    )
    // With a renderer the planner appends a newer version of an edited
    // chapter instead of cutting the ledger at its old copy, and every
    // entry keeps the exact bytes it was sent with (contextLedger).
    const planOptions = {
      render: (id: string, kind: 'fresh' | 'update') => {
        const doc = s.documents.find(d => d.id === id)
        return doc ? ledgerBlock(doc, kind) : ''
      },
      keepIds
    }
    const turn = opts.assistantMsgId
    let attachedIds: string[]
    let activeCopyOlder: boolean
    let pinnedBlock = ''
    let pinnedSent: SentTail['pinned'] = {}
    if (continuity) {
      // The ledger is frozen between summaries (§3.3): rebuilt when the
      // summary changed, when no history follows it, or when this tab has not
      // built one yet (a reload: the request it would extend is not known).
      const summaryKey = summaryPlan.summary ? summaryPlan.upToId ?? '' : ''
      let sent = sentTailRef.current
      if (epochSummaryRef.current !== summaryKey || historyMessages.length === 0) {
        ledgerRef.current = planLedgerTurn(EMPTY_LEDGER, desiredIds, docsForPlan, s.activeDocumentId, planOptions).ledger
        epochSummaryRef.current = summaryKey
        sent = { ...sent, pinned: {} }
      }
      const ledgerEntries = ledgerRef.current.entries
      const pins = desiredIds.flatMap(id => {
        const doc = s.documents.find(d => d.id === id)
        return doc ? [{ id, number: bookOrder.indexOf(id) + 1, title: doc.title, content: doc.content, hash: hashOf.get(id) ?? '' }] : []
      })
      const previousPins = sent.pinned ?? {}
      const names: Record<string, string> = {}
      for (const id of [...ledgerEntries.map(e => e.id), ...Object.keys(previousPins)]) {
        const at = bookOrder.indexOf(id)
        names[id] = at >= 0 ? `#${at + 1} "${s.documents[at].title}"` : 'a deleted chapter'
      }
      const pinned = pinnedUpdates(pins, ledgerEntries, previousPins, window.present, turn, names, keepIds)
      pinnedBlock = pinned.block
      pinnedSent = pinned.sent
      const ledgerIds = ledgerChapterIds(ledgerRef.current)
      attachedIds = [...pins.map(p => p.id), ...keepIds.filter(id => ledgerIds.includes(id))]
      // The open pinned chapter's latest copy (ledger or tail) may be older than its text now: say which is current.
      let latest: string | undefined
      if (keepIds.length > 0) {
        const copy = previousPins[keepIds[0]]
        latest = copy && window.present.includes(copy.turn) && copy.hash !== 'unpinned'
          ? copy.hash
          : [...ledgerEntries].reverse().find(e => e.id === keepIds[0])?.hash
      }
      activeCopyOlder = Boolean(latest && latest !== hashOf.get(keepIds[0]))
    } else {
      const plan: LedgerPlan = planLedgerTurn(ledgerRef.current, desiredIds, docsForPlan, s.activeDocumentId, planOptions)
      attachedIds = ledgerChapterIds(plan.ledger)
      ledgerRef.current = plan.ledger
      // The open pinned chapter's copy above may be older than its text now: say which is current.
      const activeCopy = keepIds.length > 0 ? [...plan.ledger.entries].reverse().find(e => e.id === keepIds[0]) : undefined
      activeCopyOlder = Boolean(activeCopy && activeCopy.hash !== hashOf.get(keepIds[0]))
    }
    const bookPrefixMessages = buildLedgerMessages(s.documents, ledgerRef.current.entries, undefined, { agentTools: runSettings.agentTools })
    previousAttachedIdsRef.current = attachedIds
    const markers = runSettings.agentTools
      ? freshnessMarkers(s.documents, s.activeDocumentId, attachedIds, seenRef.current, turnCounterRef.current)
      : undefined
    const tailOpts: DynamicContextOptions = {
      ...(runSettings.agentTools ? { agentTools: true, markers } : {}),
      ...(activeCopyOlder ? { activeCopyOlder: true } : {})
    }
    // The book's reference files, by reference only (attachments_and_web.md §1).
    let index = runSettings.agentTools && s.user ? renderAttachmentIndex(bookAttachments(s.activeBookId)) : ''
    if (continuity) {
      // Each part in full only when the copy the model has is gone or stale (§3.2).
      const diff = diffTailParts({
        index: buildChapterIndex(s.documents, s.activeDocumentId, { agentTools: true, markers }),
        attachments: index,
        active: selectedText || !activeDoc ? null : {
          id: activeDoc.id, number: bookOrder.indexOf(activeDoc.id) + 1, title: activeDoc.title,
          hash: `${hashOf.get(activeDoc.id) ?? ''}${activeCopyOlder ? '|older' : ''}`
        }
      }, sentTailRef.current, window.present, turn)
      tailOpts.indexOverride = diff.index
      if (pinnedBlock) tailOpts.pinnedBlock = pinnedBlock
      if (diff.active !== null) tailOpts.activeOverride = diff.active
      index = diff.attachments
      sentTailRef.current = { ...diff.sent, pinned: pinnedSent }
    }
    const dynamicContext = buildTail(tailOpts)
    // Agent turns carry no label: the pins in the sidebar are what rides along.
    const attachmentsText = agentContext ? '' : buildAttachmentsLabel(attachedIds, s.documents, autoIds)

    // The turn after a Stop says so (agentic_chat_loop.md §0.8).
    const interrupted = wasTurnInterrupted(historySource) ? `\n\n${wrapReminder(interruptedTurnReminder())}` : ''
    const files = index ? `\n\n${index}` : ''
    const finalUserMessage: LLMMessage = {
      role: 'user',
      content: `${dynamicContext}${files}\n\nUSER REQUEST:\n${promptText}${interrupted}`,
      images
    }

    const apiMessages = [systemPrompt, ...bookPrefixMessages, ...summaryPrefix, ...historyMessages, finalUserMessage]

    return {
      apiMessages,
      attachmentsText,
      estimatedInputTokens: Math.ceil(JSON.stringify(apiMessages).length / 4),
      inContextIds: [...attachedIds, s.activeDocumentId]
    }
  }, [buildSystemPrompt, buildTail, summarizeConversation, summarizeLive, selectedText])

  /**
   * Hand a message to the turn in flight. True when a run took it (the
   * message is then in the chat as the user's); false when nothing is
   * running here or the server refused (the caller queues it as a turn).
   */
  const steerRunningTurn = useCallback(async (promptText: string): Promise<boolean> => {
    const s = useAppStore.getState()
    const server = serverRunRef.current
    const local = currentRunRef.current
    if (!server && !local) return false
    const userMsg = {
      id: getTimestampId('user'), role: 'user' as const, content: promptText, timestamp: new Date().toISOString(),
      provider: s.activeProvider, model: s.providerConfigs[s.activeProvider].model
    }
    if (server) {
      if (!s.activeBookId) return false
      try {
        await steerServerRun(s.activeBookId, server.id, promptText)
      } catch (e) {
        // Not running any more (finished, paused, stopped): the caller sends it as a turn.
        if (!(e instanceof Error && e.message.includes('(409)'))) setErrorMsg(e instanceof Error ? e.message : String(e))
        return false
      }
      useAppStore.getState().addMessage(userMsg)
      forceSave()
      return true
    }
    local!.steer(promptText)
    s.addMessage(userMsg)
    forceSave()
    return true
  }, [forceSave])

  // Send message handler
  const handleSendMessage = useCallback(async (e?: React.FormEvent, customPrompt?: string) => {
    e?.preventDefault()

    const s = useAppStore.getState()
    const promptText = customPrompt ? customPrompt.trim() : chatInput.trim()
    if (!promptText) return

    // A message while a turn runs steers it (agentic_chat_loop.md §0.8): the
    // run takes it as its next user message, and the chat shows it with no
    // bubble of its own. Text only — a message with images goes the usual way
    // (a server run queues it; a tab-run is busy).
    if (s.isStreaming && uploadedImages.length === 0) {
      const steered = await steerRunningTurn(promptText)
      if (steered) {
        if (!customPrompt) {
          setChatInput('')
          if (chatInputRef.current) chatInputRef.current.innerHTML = ''
        }
        return
      }
      if (!serverRunsEnabled()) return
    } else if (s.isStreaming && !serverRunsEnabled()) {
      return
    }

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
    if (serverRunsEnabled()) {
      await startServerTurn({ promptText, images, historySource: s.messages, userMsgId: userMsg.id, assistantMsgId })
      return
    }
    s.setStreaming(true)

    accumulatedTextRef.current = ''

    const request = await assembleChatRequest({
      promptText,
      images,
      // History = the conversation BEFORE this turn (s was captured pre-add).
      historySource: s.messages,
      assistantMsgId,
      originalDocContent
    })
    if (!request) return

    await startTurn(request.apiMessages, {
      assistantMsgId,
      userMsgId: userMsg.id,
      startId: s.activeDocumentId,
      originalDocContent,
      attachmentsText: request.attachmentsText,
      estimatedInputTokens: request.estimatedInputTokens,
      inContextIds: request.inContextIds
    })
  }, [chatInput, uploadedImages, layoutMode, setIsChatExpanded, setUploadedImages, assembleChatRequest, startTurn, serverRunsEnabled, startServerTurn, steerRunningTurn])

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

    const assistantMsgId = getTimestampId('assistant')
    s.setMessages([...truncatedMessages, {
      id: assistantMsgId,
      role: 'assistant' as const,
      content: ASSISTANT_PLACEHOLDER,
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].model
    }])
    const editedMsg = truncatedMessages[truncatedMessages.length - 1]
    if (serverRunsEnabled()) {
      await startServerTurn({ promptText: trimmed, images: editedMsg?.images, historySource: truncatedMessages.slice(0, -1), userMsgId: editedMsg.id, assistantMsgId })
      return
    }
    s.setStreaming(true)

    accumulatedTextRef.current = ''

    const request = await assembleChatRequest({
      promptText: trimmed,
      images: editedMsg?.images,
      // History = everything before the edited (resubmitted) message.
      historySource: truncatedMessages.slice(0, -1),
      assistantMsgId,
      originalDocContent
    })
    if (!request) return

    await startTurn(request.apiMessages, {
      assistantMsgId,
      userMsgId: editedMsg?.id,
      startId: s.activeDocumentId,
      originalDocContent,
      attachmentsText: request.attachmentsText,
      estimatedInputTokens: request.estimatedInputTokens,
      inContextIds: request.inContextIds
    })
  }, [layoutMode, setIsChatExpanded, assembleChatRequest, startTurn, serverRunsEnabled, startServerTurn])

  /**
   * The Polish button (D9): polish a chapter directly, without the chat model
   * — no first-token wait for a decision the user already made. It runs as a
   * turn of its own (a user line, a reply with the chapter in its "changed
   * this turn" block), so the result is reviewable, undoable through the
   * version snapshot, and part of the conversation the model sees next.
   */
  const runPolish = useCallback(async (documentId: string) => {
    if (useAppStore.getState().isStreaming) return
    await useAppStore.getState().ensureDocumentContents([documentId])
    const s = useAppStore.getState()
    const doc = s.documents.find(d => d.id === documentId)
    if (!doc) return
    const base = stripDiffMarkup(doc.content)
    if (isBlankContent(base)) return

    const zh = s.language === 'zh'
    imagePlaceholdersRef.current = []
    s.addMessage({
      id: getTimestampId('user'),
      role: 'user',
      content: zh ? `润色《${doc.title}》` : `Polish "${doc.title}"`,
      timestamp: new Date().toISOString()
    })
    const assistantMsgId = getTimestampId('assistant')
    s.addMessage({
      id: assistantMsgId,
      role: 'assistant',
      content: ASSISTANT_PLACEHOLDER,
      timestamp: new Date().toISOString(),
      provider: s.activeProvider,
      model: s.providerConfigs[s.activeProvider].polishModel?.trim() ||
        defaultPolishModel(s.activeProvider, s.providerConfigs[s.activeProvider].model)
    })
    s.setStreaming(true)
    // Only the chapter being polished is locked; the rest stay editable.
    s.setEditLockedIds([documentId])
    s.createVersionSnapshot(`Auto-save before polishing "${doc.title}"`, documentId)
    if (abortControllerRef.current) abortControllerRef.current.abort()
    abortControllerRef.current = new AbortController()

    const paint = (content: string) => {
      const st = useAppStore.getState()
      st.setMessages(st.messages.map(m => (m.id === assistantMsgId ? { ...m, content } : m)))
    }
    const outcome = await polishHtml(preserveImagesWithPlaceholders(base), {
      transport: polishTransport,
      prompt: s.polishPrompt,
      writingPreset: s.customSystemPrompts.find(p => p.id === s.activeSystemPromptId)?.content,
      signal: abortControllerRef.current.signal,
      onProgress: (done, total) => paint(zh ? `✨ 润色中 ${done}/${total}…` : `✨ Polishing ${done}/${total}…`)
    })

    if (outcome.polished > 0) {
      // One reviewable diff from the last CONFIRMED text, like every write: a
      // change still under review stays under review (see docState).
      const reviewBase = base === doc.content ? base : resolveDiffMarkupInHtml(doc.content, 'reject')
      const diffed = diffHtml(reviewBase, restoreImagesFromPlaceholders(outcome.html))
      const st = useAppStore.getState()
      if (st.activeDocumentId === documentId) st.updateActiveDocument({ content: diffed })
      else st.updateDocument(documentId, { content: diffed })
    }
    const line = `✨ polished "${doc.title}" (${outcome.polished} of ${outcome.chunks} chunk(s) rewritten)`
    const notes = [
      outcome.kept.length > 0
        ? (zh ? `保留初稿的段落：${outcome.kept.join('；')}` : `Kept as drafted — ${outcome.kept.join('; ')}`)
        : '',
      outcome.stopped ? (zh ? '⏹️ 已停止，未完成的段落保留初稿。' : '⏹️ Stopped; unfinished chunks kept their draft.') : ''
    ].filter(Boolean).join('\n\n')
    const st = useAppStore.getState()
    st.setMessages(st.messages.map(m => m.id !== assistantMsgId ? m : {
      ...m,
      content: [line, notes].filter(Boolean).join('\n\n'),
      agent: {
        status: outcome.stopped ? 'stopped' : 'done',
        steps: 1,
        trace: [line],
        touched: [{
          documentId,
          titleAtRun: doc.title,
          kind: 'polished',
          changes: outcome.polished,
          failed: outcome.chunks - outcome.polished
        }],
        timeline: [{ type: 'tool', line, ok: outcome.polished > 0 }],
        suffix: notes || undefined
      }
    }))
    st.setStreaming(false)
    forceSave()
  }, [polishTransport, preserveImagesWithPlaceholders, restoreImagesFromPlaceholders, forceSave])

  // The Polish button asks through the store (it lives in the canvas header);
  // run the request once, through a ref so the effect depends on nothing but
  // the request itself (see the timeout note in CLAUDE.md).
  const runPolishRef = useRef(runPolish)
  useEffect(() => { runPolishRef.current = runPolish }, [runPolish])
  const polishRequest = useAppStore(state => state.polishRequest)
  useEffect(() => {
    if (!polishRequest) return
    useAppStore.getState().clearPolishRequest()
    void runPolishRef.current(polishRequest.documentId)
  }, [polishRequest])

  // Stop generation
  const handleStopGeneration = useCallback(() => {
    const server = serverRunRef.current
    if (server) {
      // Stop on a server run: the draft on screen is kept as one undo step
      // here (the server never saw it), and the server stops the step and
      // holds the queue. The run's `finished` event settles the bubble.
      const s = useAppStore.getState()
      const draft = keepCanvasPreview(previewBaseRef.current ?? server.toolCtx.document.original)
      if (draft !== null) s.updateActiveDocument({ content: draft })
      const live = serverLiveRef.current.get(server.id)
      if (live) live.keptDraft = draft !== null || lastSelectionPreviewRef.current > 0
      if (s.activeBookId) void serverRunAction(s.activeBookId, server.id, 'stop').catch(e => setErrorMsg(e instanceof Error ? e.message : String(e)))
      s.setStreaming(false)
      return
    }
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
  }, [keepCanvasPreview])

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
    handleRunAction,
    handleRunAnswer
  }
}
