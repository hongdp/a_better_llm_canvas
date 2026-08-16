/**
 * Tests for the resumable (server-side) generation transport.
 *
 * The contract under test is docs/features/resumable_generation.md §3/§5: SSE
 * events map onto the existing StreamCallbacks, the persisted offset is what
 * makes a reconnect duplicate- and gap-free, a start failure degrades to the
 * direct provider path, and stopping reaches the backend. fetch is mocked at
 * the boundary; nothing else is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  startRemoteGeneration,
  resumeRemoteGeneration,
  abortRemoteGeneration,
  findResumableJob,
  readPersistedJob,
  clearPersistedJob,
  RemoteStartError
} from '../remoteGeneration'
import { streamLLM } from '../llm'
import { useAppStore } from '../../store/useAppStore'
import type { LLMMessage, StreamCallbacks } from '../../types/llm'

const STORAGE_KEY = 'web_canvas_active_generation'

// ── Fetch boundary ───────────────────────────────────────────────────────────

/** A Response whose body streams `parts` one read at a time. */
function streamingResponse(parts: string[], ok = true, status = 200): Response {
  let i = 0
  const encoder = new TextEncoder()
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Server Error',
    body: {
      getReader: () => ({
        read: async () =>
          i < parts.length
            ? { value: encoder.encode(parts[i++]), done: false }
            : { value: undefined, done: true }
      })
    },
    text: async () => parts.join(''),
    json: async () => JSON.parse(parts.join(''))
  } as unknown as Response
}

/** Serializes job events the way the backend writes them onto the wire. */
const sse = (events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`)

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  } as unknown as Response
}

type Route = (url: string, init?: RequestInit) => Response | undefined
let routes: Route[] = []
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  for (const route of routes) {
    const res = route(url, init)
    if (res) return res
  }
  throw new Error(`Unrouted fetch: ${url}`)
})

const calls = () => fetchMock.mock.calls.map(c => String(c[0]))

// ── Callback recorder ────────────────────────────────────────────────────────

function recorder() {
  const chunks: string[] = []
  const done: Array<{ text: string; usage?: unknown }> = []
  const errors: string[] = []
  const callbacks: StreamCallbacks = {
    onChunk: c => chunks.push(c),
    onDone: (text, usage) => done.push({ text, usage }),
    onError: e => errors.push(e.message)
  }
  return { chunks, done, errors, callbacks }
}

const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }]
const config = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-x', baseUrl: 'https://provider.test/v1' }

beforeEach(() => {
  routes = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  clearPersistedJob()
  useAppStore.setState({ user: { username: 'alice' }, csrfToken: 'csrf-123' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAppStore.setState({ user: null, csrfToken: null })
})

describe('startRemoteGeneration', () => {

  // Regression: streamLLM wraps the caller's callbacks to add debug logging,
  // and rebuilt the object field by field — so every OPTIONAL callback was
  // silently dropped on the way to the transport. The backend streamed the
  // model's thinking for minutes and the UI never saw a byte of it.
  it('passes optional callbacks through streamLLM to the transport', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-opt' }) : undefined,
      url => url.includes('/stream')
        ? streamingResponse(sse([
            { type: 'attached', offset: 0, status: 'running' },
            { type: 'reasoning', text: 'weighing options' },
            { type: 'delta', text: 'Answer', offset: 6 },
            { type: 'done', offset: 6 }
          ]))
        : undefined
    ]
    const seen: string[] = []
    const rec = recorder()

    await streamLLM(messages, { ...config, provider: 'grok' }, {
      ...rec.callbacks,
      onAttached: () => seen.push('attached'),
      onReasoning: t => seen.push('reasoning:' + t)
    })

    expect(seen).toEqual(['attached', 'reasoning:weighing options'])
    expect(rec.done[0].text).toBe('Answer')
  })

  // Regression: the payload copies config field by field, and conversationId
  // was left out when generation moved server-side. The backend turns it into
  // xAI's x-grok-conv-id (same prompt-cache shard), so dropping it made every
  // turn a full-price, full-latency prefill — visible in the UI as ~0 cache
  // hits on a book that had been cheap to continue.
  it('forwards conversationId so the backend can route the prompt cache', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-cache' }) : undefined,
      url => url.includes('/stream') ? streamingResponse(sse([{ type: 'done', offset: 0 }])) : undefined
    ]

    await startRemoteGeneration(
      messages,
      { ...config, provider: 'grok', conversationId: 'book-42' },
      {},
      recorder().callbacks
    )

    const startInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(startInit.body)).config.conversationId).toBe('book-42')
  })

  // Same class of bug as conversationId above: the backend applies the effort,
  // so a payload that omits it silently leaves every turn on the provider's
  // default (three minutes of thinking, in the case that motivated this).
  it('forwards reasoningEffort so the backend can apply it', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-effort' }) : undefined,
      url => url.includes('/stream') ? streamingResponse(sse([{ type: 'done', offset: 0 }])) : undefined
    ]

    await startRemoteGeneration(
      messages,
      { ...config, provider: 'grok', reasoningEffort: 'low' },
      {},
      recorder().callbacks
    )

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.config.reasoningEffort).toBe('low')
  })

  // The stream announces itself before the model speaks: response headers
  // only flush with the first body byte, so a slow first token left the client
  // unable to tell a live stream from a stalled one (15s of it, measured).
  it('reports the attach before any token arrives', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-att' }) : undefined,
      url => url.includes('/stream')
        ? streamingResponse(sse([
            { type: 'attached', offset: 0, status: 'running' },
            { type: 'delta', text: 'hi', offset: 2 },
            { type: 'done', offset: 2 }
          ]))
        : undefined
    ]
    const rec = recorder()
    const order: string[] = []
    const callbacks = {
      ...rec.callbacks,
      onAttached: () => order.push('attached'),
      onChunk: (c: string) => order.push('chunk:' + c)
    }

    await startRemoteGeneration(messages, config, {}, callbacks)

    expect(order).toEqual(['attached', 'chunk:hi'])
    // It is not text: nothing lands in the message and no offset is consumed.
    expect(rec.done[0]?.text ?? '').toBe('hi')
  })

  // Reasoning is the model's thinking, not its reply: reported live so a long
  // wait is visible, but never part of the message and never an offset.
  it('reports reasoning without letting it reach the message text', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-think' }) : undefined,
      url => url.includes('/stream')
        ? streamingResponse(sse([
            { type: 'reasoning', text: 'weighing options' },
            { type: 'delta', text: 'Answer', offset: 6 },
            { type: 'done', offset: 6 }
          ]))
        : undefined
    ]
    const rec = recorder()
    const thoughts: string[] = []

    await startRemoteGeneration(messages, config, {}, { ...rec.callbacks, onReasoning: t => thoughts.push(t) })

    expect(thoughts).toEqual(['weighing options'])
    expect(rec.chunks).toEqual(['Answer'])
    expect(rec.done[0].text).toBe('Answer')
    // Reasoning advanced no offset; the finished job is cleared as usual.
    expect(readPersistedJob()).toBeNull()
  })

  // A stream that ends without a terminal event usually means the connection
  // dropped, not that the job died — the backend keeps generating. Re-attach
  // once from what was rendered so a hiccup costs a pause, not the turn.
  it('re-attaches once from the rendered offset when the stream drops', async () => {
    const streamCalls: string[] = []
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-drop' }) : undefined,
      url => {
        if (!url.includes('/stream')) return undefined
        streamCalls.push(url)
        return streamCalls.length === 1
          ? streamingResponse(sse([{ type: 'delta', text: 'Hel', offset: 3 }]))   // cut off
          : streamingResponse(sse([{ type: 'delta', text: 'lo', offset: 5 }, { type: 'done', offset: 5 }]))
      }
    ]
    const rec = recorder()

    await startRemoteGeneration(messages, config, {}, rec.callbacks)

    // The retry resumes at the offset already rendered — no gap, no duplicate.
    expect(streamCalls[1]).toContain('from=3')
    expect(rec.chunks).toEqual(['Hel', 'lo'])
    expect(rec.errors).toEqual([])
    expect(rec.done[0].text).toBe('Hello')
  })

  it('gives up after the single re-attach when the job is really gone', async () => {
    let streamAttempts = 0
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-gone' }) : undefined,
      url => {
        if (!url.includes('/stream')) return undefined
        streamAttempts++
        return streamingResponse(sse([{ type: 'delta', text: 'partial', offset: 7 }]))
      }
    ]
    const rec = recorder()

    await startRemoteGeneration(messages, config, {}, rec.callbacks)

    expect(streamAttempts).toBe(2)
    expect(rec.errors).toEqual(['Generation stream disconnected before completion'])
    // The record survives so a later page load can still pick the job up.
    expect(readPersistedJob()?.jobId).toBe('gen-gone')
  })

  it('maps SSE events onto the callback contract in order', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-1', createdAt: 'now' }) : undefined,
      url => url.includes('/api/generate/gen-1/stream')
        ? streamingResponse(sse([
            { type: 'delta', text: 'Hel', offset: 3 },
            { type: 'delta', text: 'lo', offset: 5 },
            { type: 'done', offset: 5, usage: { promptTokens: 7, completionTokens: 2 } }
          ]))
        : undefined
    ]
    const { chunks, done, errors, callbacks } = recorder()

    await startRemoteGeneration(messages, config, { assistantMessageId: 'a-1', kind: 'chat' }, callbacks)

    expect(chunks).toEqual(['Hel', 'lo'])
    expect(done).toEqual([{ text: 'Hello', usage: { promptTokens: 7, completionTokens: 2 } }])
    expect(errors).toEqual([])
    expect(calls()[1]).toContain('from=0')
  })

  it('sends the CSRF header and the provider payload on start', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-2' }) : undefined,
      () => streamingResponse(sse([{ type: 'done', offset: 0 }]))
    ]
    await startRemoteGeneration(messages, config, { kind: 'chat' }, recorder().callbacks)

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-123')
    const body = JSON.parse(init.body as string)
    expect(body.provider).toBe('openai')
    expect(body.config).toMatchObject({ apiKey: 'sk-test', model: 'gpt-x', baseUrl: 'https://provider.test/v1' })
    expect(body.messages).toEqual(messages)
    expect(body.meta).toEqual({ kind: 'chat' })
  })

  it('reports a mid-stream error event without clearing more than its own job', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-3' }) : undefined,
      () => streamingResponse(sse([
        { type: 'delta', text: 'partial', offset: 7 },
        { type: 'error', message: 'provider exploded', offset: 7 }
      ]))
    ]
    const { chunks, errors, callbacks } = recorder()

    await startRemoteGeneration(messages, config, {}, callbacks)

    expect(chunks).toEqual(['partial'])
    expect(errors).toEqual(['provider exploded'])
    expect(readPersistedJob()).toBeNull()
  })

  it('throws RemoteStartError when the job cannot be created', async () => {
    routes = [url => url.endsWith('/api/generate') ? jsonResponse({ detail: 'boom' }, false, 500) : undefined]

    await expect(
      startRemoteGeneration(messages, config, {}, recorder().callbacks)
    ).rejects.toBeInstanceOf(RemoteStartError)
    expect(readPersistedJob()).toBeNull()
  })
})

describe('persisted job record', () => {
  it('advances the offset as chunks render and clears it on completion', async () => {
    const seen: Array<number | null> = []
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-4' }) : undefined,
      () => streamingResponse(sse([
        { type: 'delta', text: 'abc', offset: 3 },
        { type: 'delta', text: 'de', offset: 5 },
        { type: 'done', offset: 5 }
      ]))
    ]
    const callbacks: StreamCallbacks = {
      // Sampling inside onChunk proves the offset is persisted as the text is
      // rendered, not only at the end.
      onChunk: () => seen.push(readPersistedJob()?.offset ?? null),
      onDone: () => {},
      onError: () => {}
    }

    await startRemoteGeneration(messages, config, { assistantMessageId: 'a-4' }, callbacks)

    // The first sample is taken before the first chunk's offset is written.
    expect(seen).toEqual([0, 3])
    expect(readPersistedJob()).toBeNull()
  })

  it('keeps the record when the stream drops without a terminal event', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-5' }) : undefined,
      () => streamingResponse(sse([{ type: 'delta', text: 'Hello', offset: 5 }]))
    ]
    const { errors, callbacks } = recorder()

    await startRemoteGeneration(messages, config, { assistantMessageId: 'a-5', kind: 'chat' }, callbacks)

    expect(errors[0]).toContain('disconnected')
    expect(readPersistedJob()).toEqual({ jobId: 'gen-5', meta: { assistantMessageId: 'a-5', kind: 'chat' }, offset: 5 })
  })

  it('ignores a corrupt record instead of blocking generation', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')
    expect(readPersistedJob()).toBeNull()
  })
})

describe('resumeRemoteGeneration', () => {
  it('reattaches at the stored offset with no duplicate and no gap', async () => {
    // The server buffer is "Hello world"; the tab dies after "Hello". Within a
    // live page the client would now self-heal, so the tab's death is modelled
    // by failing the in-page reconnect too — only then is this a cold reload.
    let fromFiveHits = 0
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-6' }) : undefined,
      url => url.includes('from=0')
        ? streamingResponse(sse([{ type: 'delta', text: 'Hello', offset: 5 }]))
        : undefined,
      url => {
        if (!url.includes('from=5')) return undefined
        fromFiveHits++
        return fromFiveHits === 1
          ? jsonResponse({ detail: 'Generation job not found.' }, false, 404)  // the page is gone
          : streamingResponse(sse([
              { type: 'delta', text: ' world', offset: 11 },
              { type: 'done', offset: 11 }
            ]))
      }
    ]
    const first = recorder()
    await startRemoteGeneration(messages, config, { assistantMessageId: 'a-6' }, first.callbacks)

    const stored = readPersistedJob()!
    expect(stored.offset).toBe(5)

    const second = recorder()
    await resumeRemoteGeneration(stored.jobId, stored.offset, second.callbacks)

    expect(calls()[3]).toContain('/api/generate/gen-6/stream?from=5')
    expect(first.chunks.join('') + second.chunks.join('')).toBe('Hello world')
    expect(second.done[0].text).toBe(' world')
    expect(readPersistedJob()).toBeNull()
  })
})

describe('findResumableJob', () => {
  const persist = (offset: number) =>
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId: 'gen-7', meta: { assistantMessageId: 'a-7' }, offset }))

  it('resumes a job that is still running', async () => {
    persist(4)
    routes = [url => url.endsWith('/api/generate/active')
      ? jsonResponse([{ jobId: 'gen-7', status: 'running', length: 4, meta: {} }])
      : undefined]

    expect(await findResumableJob()).toEqual({ jobId: 'gen-7', meta: { assistantMessageId: 'a-7' }, offset: 4 })
  })

  it('resumes a finished job whose buffer is longer than what was rendered', async () => {
    persist(4)
    routes = [url => url.endsWith('/api/generate/active')
      ? jsonResponse([{ jobId: 'gen-7', status: 'done', length: 40 }])
      : undefined]

    expect((await findResumableJob())?.offset).toBe(4)
  })

  it('forgets a finished job that was fully rendered', async () => {
    persist(40)
    routes = [url => url.endsWith('/api/generate/active')
      ? jsonResponse([{ jobId: 'gen-7', status: 'done', length: 40 }])
      : undefined]

    expect(await findResumableJob()).toBeNull()
    expect(readPersistedJob()).toBeNull()
  })

  it('forgets a job the server no longer knows about', async () => {
    persist(4)
    routes = [url => url.endsWith('/api/generate/active') ? jsonResponse([]) : undefined]

    expect(await findResumableJob()).toBeNull()
    expect(readPersistedJob()).toBeNull()
  })

  it('keeps the record when the lookup itself fails (backend still booting)', async () => {
    persist(4)
    routes = [url => url.endsWith('/api/generate/active') ? jsonResponse({}, false, 503) : undefined]

    expect(await findResumableJob()).toBeNull()
    expect(readPersistedJob()?.jobId).toBe('gen-7')
  })

  it('makes no request at all without a persisted job', async () => {
    expect(await findResumableJob()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('abortRemoteGeneration', () => {
  it('posts to the abort endpoint for the running job and forgets it', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-8' }) : undefined,
      url => url.includes('/stream') ? streamingResponse(sse([{ type: 'delta', text: 'x', offset: 1 }])) : undefined,
      url => url.endsWith('/api/generate/gen-8/abort') ? jsonResponse({ success: true }) : undefined
    ]
    await startRemoteGeneration(messages, config, {}, recorder().callbacks)

    // No job id: the stop button aborts whatever this tab is reading.
    await abortRemoteGeneration()

    const abortCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/abort'))!
    expect(abortCall).toBeDefined()
    expect((abortCall[1] as RequestInit).method).toBe('POST')
    expect(((abortCall[1] as RequestInit).headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-123')
    expect(readPersistedJob()).toBeNull()
  })

  it('is a no-op when nothing is running', async () => {
    await abortRemoteGeneration()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('streamLLM transport selection', () => {
  const openAIStream = () => streamingResponse([
    'data: {"choices":[{"delta":{"content":"direct "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n'
  ])

  it('uses the remote transport when logged in', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-9' }) : undefined,
      url => url.includes('/stream') ? streamingResponse(sse([
        { type: 'delta', text: 'remote', offset: 6 },
        { type: 'done', offset: 6 }
      ])) : undefined
    ]
    const { chunks, done, callbacks } = recorder()

    await streamLLM(messages, config, callbacks)

    expect(chunks).toEqual(['remote'])
    expect(done[0].text).toBe('remote')
    expect(calls().some(u => u.includes('provider.test'))).toBe(false)
  })

  it('falls back to the direct path when the remote start fails', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ detail: 'down' }, false, 500) : undefined,
      url => url.startsWith('https://provider.test') ? openAIStream() : undefined
    ]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { done, errors, callbacks } = recorder()

    await streamLLM(messages, config, callbacks)

    expect(errors).toEqual([])
    expect(done[0].text).toBe('direct answer')
    expect(calls()).toEqual(['/api/generate', 'https://provider.test/v1/chat/completions'])
  })

  it('does not fall back once the job is running (no double generation)', async () => {
    routes = [
      url => url.endsWith('/api/generate') ? jsonResponse({ jobId: 'gen-10' }) : undefined,
      url => url.includes('/stream') ? streamingResponse(sse([{ type: 'error', message: 'provider 429', offset: 0 }])) : undefined
    ]
    const { errors, callbacks } = recorder()

    await streamLLM(messages, config, callbacks)

    expect(errors).toEqual(['provider 429'])
    expect(calls().some(u => u.includes('provider.test'))).toBe(false)
  })

  it('stays direct when logged out or when forceDirect is set', async () => {
    routes = [url => url.startsWith('https://provider.test') ? openAIStream() : undefined]

    useAppStore.setState({ user: null })
    const loggedOut = recorder()
    await streamLLM(messages, config, loggedOut.callbacks)
    expect(loggedOut.done[0].text).toBe('direct answer')

    useAppStore.setState({ user: { username: 'alice' } })
    routes = [url => url.startsWith('https://provider.test') ? openAIStream() : undefined]
    const forced = recorder()
    await streamLLM(messages, { ...config, forceDirect: true }, forced.callbacks)
    expect(forced.done[0].text).toBe('direct answer')

    expect(calls().every(u => u.startsWith('https://provider.test'))).toBe(true)
  })
})
