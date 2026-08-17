import { useAppStore } from '../store/useAppStore'
import { streamLLM } from './llm'
import {
  detectSummaryLanguage,
  hashDocumentContent,
  isSummaryStale,
  buildSummaryInput,
  MIN_CHARS_FOR_SUMMARY
} from '../utils/chapterIndex'
import type { SummaryLanguage } from '../utils/chapterIndex'

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
  /**
   * The queue is intentionally idle because a chat/roleplay stream is running
   * (and, on a single-slot local server, would be blocked by it anyway). The
   * UI must say THAT — shown as "Summarizing…" this state reads as stuck, and
   * a several-minute chat generation makes it read that way for minutes.
   */
  waitingForChat: boolean
  lastError: string | null
  completedThisRun: number
}
type QueueListener = (status: SummaryQueueStatus) => void
const listeners = new Set<QueueListener>()
let lastError: string | null = null
let completedThisRun = 0
let waitingForChat = false
/** True from the first item of a run until the queue drains — spans defers. */
let runActive = false

const notify = () => {
  const status: SummaryQueueStatus = {
    pending: pendingQueue.length,
    running: processing,
    waitingForChat,
    lastError,
    completedThisRun
  }
  listeners.forEach(l => l(status))
}

export const subscribeSummaryQueue = (listener: QueueListener): (() => void) => {
  listeners.add(listener)
  listener({ pending: pendingQueue.length, running: processing, waitingForChat, lastError, completedThisRun })
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

/**
 * The instruction, in the language the summary must come back in.
 *
 * Measured on a local Qwen3.8 IQ2_M, three runs per prompt over the same
 * Chinese chapter: the English instruction gave 83%, 83%, 0% Chinese (the
 * failure also running to 1,475 characters against a 300-character cap), the
 * Chinese one 82%, 83%, 87% at 352-490 characters. Same-language instructions
 * do not change what the model CAN do — they change how often it does it.
 */
const SUMMARY_SYSTEM_PROMPT: Record<SummaryLanguage, string> = {
  zh: '你把小说章节压缩成简短的参考笔记。必须用中文书写。只输出纯文本，不要 markdown，不要 HTML，不要前言。',
  ja: 'あなたは小説の章を短い参照メモに要約します。必ず日本語で書いてください。プレーンテキストのみ、markdown も HTML も前置きも不要です。',
  ko: '당신은 소설 장을 짧은 참고 메모로 요약합니다. 반드시 한국어로 작성하세요. 마크다운, HTML, 서두 없이 일반 텍스트만 출력하세요.',
  other: 'You summarize book chapters into compact reference notes. Write in the same language as the chapter. Output plain text only — no markdown, no HTML, no preamble.'
}

function buildSummaryUserPrompt(language: SummaryLanguage, title: string, text: string): string {
  const instruction = {
    zh: `用中文概括这一章，然后用「- 」列出关键人物、实体和事实。\n\n硬性限制（每条摘要都会在每一轮对话中被重新读取，超长比没有更糟）：\n- 概括部分最多 300 个汉字\n- 列表最多 8 条\n- 不要前言，不要「摘要：」这类标签，不要翻译成其他语言`,
    ja: `この章を日本語で要約し、主要な人物・固有名詞・事実を「- 」で列挙してください。\n\n厳守（毎ターン読み込まれるため、長すぎる要約は無いより悪い）：\n- 要約は最大 300 文字\n- 箇条書きは最大 8 個\n- 前置き・ラベル・翻訳は不要`,
    ko: `이 장을 한국어로 요약한 뒤, 주요 인물·고유명사·사실을 "- "로 나열하세요.\n\n반드시 지킬 것 (매 턴마다 다시 읽히므로 너무 긴 요약은 없느니만 못합니다):\n- 요약은 최대 300자\n- 항목은 최대 8개\n- 서두, 라벨, 번역 금지`,
    other: `Summarize this chapter in the language it is written in, then list its key characters, entities, and facts as short "- " bullets.\n\nHard limits — every summary is re-read on every turn, so overrunning them is worse than having none:\n- the summary: at most 200 words\n- the bullets: at most 8\n- no preamble, no "Summary:" label, no translation`
  }[language]

  const titleLabel = language === 'other' ? 'CHAPTER TITLE' : '章节标题 / CHAPTER TITLE'
  const textLabel = language === 'other' ? 'CHAPTER TEXT' : '章节正文 / CHAPTER TEXT'
  return `${instruction}\n\n${titleLabel}: ${title}\n\n${textLabel}:\n${text}`
}

const summarizeDocument = async (docId: string): Promise<void> => {
  const s = useAppStore.getState()
  const doc = s.documents.find(d => d.id === docId)
  if (!doc) return

  const contentHash = hashDocumentContent(doc.content)
  const input = buildSummaryInput(doc)
  // The instruction goes out IN the chapter's language. An English one mostly
  // works and then occasionally returns an English summary at five times the
  // length cap; see SUMMARY_SYSTEM_PROMPT for the measurements.
  const language = detectSummaryLanguage(input)
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
      content: SUMMARY_SYSTEM_PROMPT[language]
    },
    {
      role: 'user' as const,
      content: buildSummaryUserPrompt(language, doc.title, input)
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
  // A defer retry re-enters here mid-run; resetting the counters there turned
  // "1 done" into "0 done" on screen. Only a FRESH run starts from zero.
  if (!runActive) {
    runActive = true
    lastError = null
    completedThisRun = 0
  }
  notify()
  try {
    while (pendingQueue.length > 0) {
      // Defer while a chat/roleplay stream is running: on a single-slot local
      // server the chat generation holds the only slot anyway. This is a
      // distinct, visible state — not "Summarizing…".
      if (useAppStore.getState().isStreaming) {
        debugLog('stream in flight — deferring queue')
        waitingForChat = true
        setTimeout(() => { void processQueue() }, DEFER_RETRY_MS)
        return
      }
      waitingForChat = false
      const docId = pendingQueue.shift()!
      const force = forcedIds.delete(docId)
      // Re-check: content may have changed (or been summarized) since enqueue.
      if (!needsRefresh(docId, force)) continue
      await summarizeDocument(docId)
    }
    runActive = false
    waitingForChat = false
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
