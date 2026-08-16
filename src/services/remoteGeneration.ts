/**
 * Remote (server-side) generation transport —
 * see docs/features/resumable_generation.md.
 *
 * A browser tab is not a safe host for a long generation: mobile Firefox
 * discards a backgrounded tab and the provider connection dies with it, so
 * everything produced so far is lost. When the user is logged in the
 * generation therefore runs as a job inside the FastAPI backend and the tab
 * is only a reader that may detach and re-attach at any character offset.
 *
 * The job buffer on the server is the source of truth; this module keeps just
 * enough in localStorage (`{ jobId, meta, offset }`) to find its way back
 * after the tab is destroyed.
 */
import type { LLMMessage, ProviderConfig, StreamCallbacks } from '../types/llm'
import { localStorage } from '../store/persistence'
import { useAppStore } from '../store/useAppStore'
import { readSSEDataLines } from './llm'

/** Opaque-to-the-server job description, echoed back by `/api/generate/active`. */
export interface RemoteJobMeta {
  bookId?: string
  documentId?: string
  /** Chat bubble this job streams into — the anchor a rejoin needs. */
  assistantMessageId?: string
  kind?: 'chat' | 'roleplay' | 'summary' | 'batch'
}

export interface PersistedGenerationJob {
  jobId: string
  meta: RemoteJobMeta
  /** Characters of the job buffer this client has already rendered. */
  offset: number
}

export interface RemoteJobInfo {
  jobId: string
  status: 'running' | 'done' | 'error' | 'aborted'
  meta?: RemoteJobMeta
  length?: number
  createdAt?: string
  updatedAt?: string
}

/** Namespaced like every other client-owned key (see store/persistence.ts). */
const ACTIVE_JOB_KEY = 'web_canvas_active_generation'

/**
 * Thrown only when the job could not be STARTED (backend down, 4xx/5xx, no
 * jobId). It is the single condition under which `streamLLM` may fall back to
 * the direct transport: once a job exists, re-running it locally would
 * double-generate.
 */
export class RemoteStartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteStartError'
  }
}

// The job this tab is currently reading. Module-level (single owner) so the
// stop button can abort it without threading the id through the UI.
let activeJobId: string | null = null

// ── Persisted job record ──────────────────────────────────────────────────────

export function readPersistedJob(): PersistedGenerationJob | null {
  const raw = localStorage.getItem(ACTIVE_JOB_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedGenerationJob>
    if (!parsed || typeof parsed.jobId !== 'string') return null
    return {
      jobId: parsed.jobId,
      meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
      offset: typeof parsed.offset === 'number' && parsed.offset >= 0 ? parsed.offset : 0
    }
  } catch {
    // Corrupt record: treat it as absent rather than blocking generation.
    return null
  }
}

function writePersistedJob(job: PersistedGenerationJob): void {
  localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(job))
}

export function clearPersistedJob(): void {
  localStorage.removeItem(ACTIVE_JOB_KEY)
}

// ── Requests ──────────────────────────────────────────────────────────────────

/** Same cookie session + double-submit CSRF header the store's writes send. */
function apiHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-CSRF-Token': useAppStore.getState().csrfToken || ''
  }
}

/**
 * True when generation should run on the backend: the endpoints are
 * session-scoped, so a logged-out client has nowhere to put the job.
 * Read lazily (never at module load) to keep the store graph out of the
 * import cycle.
 */
/**
 * Re-attach attempts after a stream ends without a terminal event. One is
 * enough to ride out a proxy hiccup; a job that no longer exists fails its
 * retry immediately (404), so this costs nothing when the server really died.
 */
const MAX_STREAM_RECONNECTS = 1
const STREAM_RECONNECT_DELAY_MS = 500

export function isRemoteGenerationAvailable(): boolean {
  return !!useAppStore.getState().user
}

/**
 * Attach to a job's SSE stream from `fromOffset` and map its events onto the
 * shared StreamCallbacks contract. Never throws: transport problems are
 * reported through `onError`, exactly like the direct provider paths.
 */
async function attachToJob(
  jobId: string,
  fromOffset: number,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  reconnectsLeft: number = MAX_STREAM_RECONNECTS,
  carryText: string = ''
): Promise<void> {
  let offset = fromOffset
  // Text THIS reader rendered. On a resume it deliberately excludes the
  // replayed-before-the-offset prefix — onDone reports what was streamed here.
  // A mid-turn reconnect carries it forward: one logical attach must report
  // one whole answer, or the caller would parse only the tail.
  let fullText = carryText
  let terminal = false

  try {
    const response = await fetch(
      `/api/generate/${encodeURIComponent(jobId)}/stream?from=${offset}`,
      { signal }
    )
    if (!response.ok) {
      throw new Error(`Generation stream failed (${response.status}): ${response.statusText}`)
    }

    await readSSEDataLines(response, (dataString) => {
      if (!dataString || dataString === '[DONE]') return
      let event: {
        type?: string
        text?: string
        offset?: number
        message?: string
        usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }
      }
      try {
        event = JSON.parse(dataString)
      } catch (e) {
        console.warn('[RemoteGeneration] Failed to parse SSE payload', e, dataString)
        return
      }

      if (event.type === 'attached') {
        // The stream is live but the model has not spoken yet. Sent so the UI
        // can tell "connected, waiting" from "nothing is happening" — see the
        // header-flush note in server_generation._job_event_stream.
        callbacks.onAttached?.()
      } else if (event.type === 'reasoning') {
        // Thinking, not text: it never joins fullText and never advances the
        // offset, so a reconnect simply misses what was thought while away.
        if (event.text) callbacks.onReasoning?.(event.text)
      } else if (event.type === 'delta') {
        const text = event.text || ''
        if (!text) return
        fullText += text
        callbacks.onChunk(text)
        // The server sends the buffer length AFTER this event; advancing the
        // persisted offset only once the chunk is rendered is what makes a
        // reconnect gap-free and duplicate-free.
        offset = typeof event.offset === 'number' ? event.offset : offset + text.length
        persistOffset(jobId, offset)
      } else if (event.type === 'done') {
        terminal = true
        clearActiveJob(jobId)
        callbacks.onDone(fullText, event.usage)
      } else if (event.type === 'error') {
        terminal = true
        clearActiveJob(jobId)
        callbacks.onError(new Error(event.message || 'Remote generation failed'))
      }
    }, signal)

    if (!terminal) {
      // Body ended without a terminal event: the connection dropped, or the
      // server went away. The job may well still be generating, so re-attach
      // once from what was rendered — a transient drop then costs nothing but
      // a pause, and only a job that is really gone becomes an error.
      if (reconnectsLeft > 0 && !signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, STREAM_RECONNECT_DELAY_MS))
        return attachToJob(jobId, offset, callbacks, signal, reconnectsLeft - 1, fullText)
      }
      // Keep the persisted record: a later page load can still pick the job up
      // if it survived. Reporting beats pretending a truncated answer is whole.
      callbacks.onError(new Error('Generation stream disconnected before completion'))
    }
  } catch (error) {
    if (!terminal) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

function persistOffset(jobId: string, offset: number): void {
  const persisted = readPersistedJob()
  if (!persisted || persisted.jobId !== jobId) return
  writePersistedJob({ ...persisted, offset })
}

function clearActiveJob(jobId: string): void {
  if (activeJobId === jobId) activeJobId = null
  const persisted = readPersistedJob()
  if (!persisted || persisted.jobId === jobId) clearPersistedJob()
}

/**
 * Start a backend generation job and stream it into `callbacks`.
 *
 * Throws {@link RemoteStartError} when the job could never be created, which
 * is the caller's signal to fall back to the direct transport. Everything
 * after a successful start is reported through the callbacks.
 */
export async function startRemoteGeneration(
  messages: LLMMessage[],
  config: ProviderConfig & { provider: string; conversationId?: string },
  meta: RemoteJobMeta,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  let jobId: string
  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        provider: config.provider,
        config: {
          apiKey: config.apiKey,
          model: config.model,
          baseUrl: config.baseUrl,
          maxOutputTokens: config.maxOutputTokens,
          geminiSafetySettings: config.geminiSafetySettings,
          // Forwarded, not dropped: the backend turns this into xAI's
          // x-grok-conv-id, which routes the turn to the same prompt-cache
          // shard. Omitting it silently made every turn a full-price,
          // full-latency prefill once generation moved server-side.
          conversationId: config.conversationId,
          // Same lesson: the backend cannot apply an effort it never receives.
          reasoningEffort: config.reasoningEffort
        },
        messages,
        meta
      }),
      signal
    })
    if (!response.ok) {
      throw new Error(`(${response.status}) ${response.statusText}`)
    }
    const data = await response.json()
    if (!data || typeof data.jobId !== 'string') {
      throw new Error('response contained no jobId')
    }
    jobId = data.jobId
  } catch (error) {
    throw new RemoteStartError(
      `Failed to start remote generation: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  activeJobId = jobId
  writePersistedJob({ jobId, meta, offset: 0 })
  await attachToJob(jobId, 0, callbacks, signal)
}

/**
 * Re-attach to an existing job (page reload, second device) from the offset
 * the client already rendered.
 */
export async function resumeRemoteGeneration(
  jobId: string,
  fromOffset: number,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  activeJobId = jobId
  const persisted = readPersistedJob()
  // Keep the record in sync so the offset keeps advancing from the right base
  // even when the resume was driven by a caller-supplied offset.
  writePersistedJob({
    jobId,
    meta: persisted?.jobId === jobId ? persisted.meta : {},
    offset: fromOffset
  })
  await attachToJob(jobId, fromOffset, callbacks, signal)
}

/**
 * Cancel the provider request behind a job. Called by the stop button in
 * addition to dropping the local reader — otherwise the backend would keep
 * burning tokens for a stream nobody reads.
 *
 * Defaults to the job this tab is reading (or the persisted one), so callers
 * that know nothing about jobs can call it unconditionally.
 */
export async function abortRemoteGeneration(jobId?: string): Promise<void> {
  const target = jobId ?? activeJobId ?? readPersistedJob()?.jobId
  if (!target) return

  // Forget it locally first: the user asked to stop, so a failed abort call
  // must not leave the job around to be rejoined on the next load.
  clearActiveJob(target)

  try {
    await fetch(`/api/generate/${encodeURIComponent(target)}/abort`, {
      method: 'POST',
      headers: apiHeaders()
    })
  } catch (e) {
    console.warn('[RemoteGeneration] Failed to abort remote job', e)
  }
}

/** Jobs the backend still knows about for this session (running or retained). */
export async function fetchActiveGenerations(): Promise<RemoteJobInfo[]> {
  const response = await fetch('/api/generate/active')
  if (!response.ok) {
    throw new Error(`Failed to list active generations (${response.status})`)
  }
  const data = await response.json()
  return Array.isArray(data) ? (data as RemoteJobInfo[]) : []
}

/**
 * Decide whether the persisted job is still worth re-attaching to.
 *
 * Resumable when it is still `running`, or when it finished inside the
 * retention window with a buffer longer than what this client rendered (the
 * tab died between the last chunk and the terminal event). Anything else is
 * forgotten. A failed lookup leaves the record alone — the backend may just
 * be starting up.
 */
export async function findResumableJob(): Promise<PersistedGenerationJob | null> {
  const persisted = readPersistedJob()
  if (!persisted) return null

  let jobs: RemoteJobInfo[]
  try {
    jobs = await fetchActiveGenerations()
  } catch {
    return null
  }

  const job = jobs.find(j => j.jobId === persisted.jobId)
  if (!job) {
    // Server restart or retention expiry: nothing to come back to.
    clearPersistedJob()
    return null
  }

  const hasUnrenderedText = typeof job.length === 'number' && job.length > persisted.offset
  if (job.status !== 'running' && !hasUnrenderedText) {
    clearPersistedJob()
    return null
  }

  return {
    jobId: job.jobId,
    meta: persisted.meta && Object.keys(persisted.meta).length > 0 ? persisted.meta : (job.meta || {}),
    offset: persisted.offset
  }
}
