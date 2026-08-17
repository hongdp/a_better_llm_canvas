import { useAppStore } from '../store/useAppStore'
import { streamLLM } from './llm'
import {
  hashDocumentContent,
  isSummaryStale,
  buildSummaryInput,
  MIN_CHARS_FOR_SUMMARY
} from '../utils/chapterIndex'

/**
 * Background chapter summarizer feeding the always-on chapter index
 * (docs/features/smart_context_selection.md §2).
 *
 * Design constraints:
 * - Staleness is tolerated: summaries are navigation metadata, so refreshes
 *   are lazy — typing must NEVER fan out into LLM calls. Triggers are
 *   edit-idle (60s), chapter switch, and send-time (non-blocking).
 * - Serial queue, silent failure: a failed refresh keeps the stale summary
 *   and the doc simply re-qualifies as stale next trigger.
 * - Never runs while a chat/roleplay stream is in flight (the stream owns
 *   the provider budget and may be mutating the active document).
 */

const EDIT_IDLE_MS = 60_000
/** Retry delay when a refresh is deferred because a stream is in flight. */
const DEFER_RETRY_MS = 10_000

const pendingQueue: string[] = []
/**
 * Queue-progress listeners. The summarizer is deliberately silent about
 * failures (a stale summary is harmless), but silence also made the sidebar
 * buttons look dead — pressing one produced no visible change whether it
 * queued 12 chapters, skipped them all, or failed outright. The UI subscribes
 * here so it can show what actually happened.
 */
export interface SummaryQueueStatus {
  pending: number
  running: boolean
  lastError: string | null
  completedThisRun: number
}
type QueueListener = (status: SummaryQueueStatus) => void
const listeners = new Set<QueueListener>()
let lastError: string | null = null
let completedThisRun = 0

const notify = () => {
  const status: SummaryQueueStatus = {
    pending: pendingQueue.length,
    running: processing,
    lastError,
    completedThisRun
  }
  listeners.forEach(l => l(status))
}

export const subscribeSummaryQueue = (listener: QueueListener): (() => void) => {
  listeners.add(listener)
  listener({ pending: pendingQueue.length, running: processing, lastError, completedThisRun })
  return () => { listeners.delete(listener) }
}
// Ids whose refresh was requested manually — they bypass the staleness check
// (but never the loaded/length guards).
const forcedIds = new Set<string>()
let processing = false
let idleTimer: ReturnType<typeof setTimeout> | null = null
let idleDocId: string | null = null
let initialized = false

const debugLog = (...args: unknown[]) => {
  if (useAppStore.getState().debugMode) {
    console.log('[ChapterSummaries]', ...args)
  }
}

/** A doc qualifies for a refresh when it's stale and long enough to need one. */
const needsRefresh = (docId: string, force = false): boolean => {
  const doc = useAppStore.getState().documents.find(d => d.id === docId)
  if (!doc || doc.contentLoaded === false) return false
  if (doc.content.length < MIN_CHARS_FOR_SUMMARY) return false
  return force || isSummaryStale(doc)
}

/** Queue a summary refresh for a document (deduplicated). `force` skips the
 * staleness check — used by the manual sidebar refresh. */
export const enqueueSummaryRefresh = (docId: string, force = false) => {
  if (!needsRefresh(docId, force)) return
  if (force) forcedIds.add(docId)
  if (!pendingQueue.includes(docId)) {
    pendingQueue.push(docId)
    debugLog('enqueued', docId, `(queue: ${pendingQueue.length})`)
    notify()
  }
  void processQueue()
}

/**
 * Queue refreshes for every stale chapter. Called at send-time: the current
 * turn uses existing summaries immediately; fresh ones serve the next turn.
 */
export const enqueueStaleSummaryRefreshes = () => {
  for (const doc of useAppStore.getState().documents) {
    enqueueSummaryRefresh(doc.id)
  }
}

const summarizeDocument = async (docId: string): Promise<void> => {
  const s = useAppStore.getState()
  const doc = s.documents.find(d => d.id === docId)
  if (!doc) return

  const contentHash = hashDocumentContent(doc.content)
  const input = buildSummaryInput(doc)
  // Summaries are background drudge work on every chapter, so they get their
  // own provider: leaving them on the chat provider bills a frontier model for
  // work a local one does fine. 'active' keeps the old behaviour.
  const provider = s.summaryProvider === 'active' ? s.activeProvider : s.summaryProvider
  const baseConfig = s.providerConfigs[provider]
  // And, within it, the cheap utility model when one is configured.
  const config = baseConfig.summaryModel?.trim()
    ? { ...baseConfig, model: baseConfig.summaryModel.trim() }
    : baseConfig

  const messages = [
    {
      role: 'system' as const,
      content: 'You summarize book chapters into compact reference notes. Output plain text only — no markdown, no HTML, no preamble.'
    },
    {
      role: 'user' as const,
      content: `Summarize this chapter in about 120 words, then list its key characters, entities, and facts as short "- " bullets.\n\nCHAPTER TITLE: ${doc.title}\n\nCHAPTER TEXT:\n${input}`
    }
  ]

  await new Promise<void>((resolve) => {
    streamLLM(
      messages,
      { ...config, provider, debug: s.debugMode, conversationId: s.activeBookId },
      {
        onChunk: () => {},
        onDone: (fullText) => {
          const summary = fullText.trim()
          if (summary) {
            // Hash captured before the call: if the user edited meanwhile,
            // the mismatch correctly re-marks the doc stale.
            useAppStore.getState().setDocumentSummary(docId, summary, contentHash)
            completedThisRun++
            debugLog('summarized', docId, `(${summary.length} chars)`)
            notify()
          }
          resolve()
        },
        onError: (err) => {
          // The summary itself fails softly (the stale one stays usable), but
          // the reason is now reported so a misconfigured model or a dead key
          // is visible instead of looking like a dead button.
          lastError = err.message
          debugLog('summary failed', docId, err.message)
          notify()
          resolve()
        }
      }
    )
  })
}

const processQueue = async (): Promise<void> => {
  if (processing) return
  processing = true
  lastError = null
  completedThisRun = 0
  notify()
  try {
    while (pendingQueue.length > 0) {
      // Defer while a chat/roleplay stream is running.
      if (useAppStore.getState().isStreaming) {
        debugLog('stream in flight — deferring queue')
        setTimeout(() => { void processQueue() }, DEFER_RETRY_MS)
        return
      }
      const docId = pendingQueue.shift()!
      const force = forcedIds.delete(docId)
      // Re-check: content may have changed (or been summarized) since enqueue.
      if (!needsRefresh(docId, force)) continue
      await summarizeDocument(docId)
    }
  } finally {
    processing = false
    notify()
  }
}

/**
 * Start the summarizer's store subscription. Called once from main.tsx.
 * Watches for:
 * - active-document switches → refresh the chapter being left;
 * - content edits → (re)start that chapter's 60s idle timer.
 */
export const initChapterSummarizer = () => {
  if (initialized) return
  initialized = true

  useAppStore.subscribe((state, prevState) => {
    // Chapter switch: summarize the document being left.
    if (state.activeDocumentId !== prevState.activeDocumentId && prevState.activeDocumentId) {
      enqueueSummaryRefresh(prevState.activeDocumentId)
    }

    // Content edit on the active document: restart its idle timer. Comparing
    // object identity is enough — the store replaces the doc object on edit.
    if (state.documents !== prevState.documents) {
      const active = state.documents.find(d => d.id === state.activeDocumentId)
      const prevActive = prevState.documents.find(d => d.id === state.activeDocumentId)
      if (active && prevActive && active.content !== prevActive.content) {
        if (idleTimer && idleDocId === active.id) clearTimeout(idleTimer)
        idleDocId = active.id
        idleTimer = setTimeout(() => {
          idleTimer = null
          // Skip if a stream is writing into the doc; staleness persists and
          // a later trigger (switch/send) will pick it up.
          if (!useAppStore.getState().isStreaming) {
            enqueueSummaryRefresh(active.id)
          }
        }, EDIT_IDLE_MS)
      }
    }
  })
}
