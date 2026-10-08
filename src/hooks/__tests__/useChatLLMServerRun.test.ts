/**
 * The chat hook with `serverRuns` on: a turn is posted to the server and the
 * bubble and editor follow the run's events (backend_authority.md §4.3).
 * The API is a mocked fetch; the events come straight from the emitter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('../../services/llm', () => ({ streamLLM: vi.fn() }))
vi.mock('../../services/chapterSummaries', () => ({ enqueueStaleSummaryRefreshes: vi.fn() }))

import { useChatLLM } from '../useChatLLM'
import { useAppStore, isEditLocked } from '../../store/useAppStore'
import { emitRunEvent } from '../../store/runEvents'
import type { ServerRunSummary } from '../../services/serverRuns'

interface Harness { current: ReturnType<typeof useChatLLM>; unmount: () => void }

function renderChatHook(editor: unknown = null): Harness {
  const harness = { current: null as unknown as ReturnType<typeof useChatLLM> } as Harness
  const Probe = () => {
    harness.current = useChatLLM({
      activeEditor: editor as never, selectedText: '', uploadedImages: [], setUploadedImages: vi.fn(),
      layoutMode: 'landscape', setIsChatExpanded: vi.fn(), forceSave: vi.fn(), setSaveStatus: vi.fn()
    })
    return null
  }
  let root: Root
  act(() => { root = createRoot(document.createElement('div')); root.render(createElement(Probe)) })
  harness.unmount = () => act(() => root.unmount())
  return harness
}

function stubEditor(html: string) {
  const writes: string[] = []
  const chain = { setMeta: () => chain, setContent: (c: string) => { writes.push(c); html = c; return chain }, run: () => true }
  return { writes, editor: { chain: () => chain, getHTML: () => html, commands: { setContent: (c: string) => { writes.push(c); html = c } }, state: { selection: { from: 0, to: 0 } } } }
}

const doc = (id: string, title: string, content: string) => ({ id, title, content, contentLoaded: true, createdAt: 't', updatedAt: 't' })
const bubble = () => useAppStore.getState().messages.filter(m => m.role === 'assistant').at(-1)!
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() }) }

const summary = (over: Partial<ServerRunSummary> = {}): ServerRunSummary => ({
  id: 'run-1', bookId: 'book-1', status: 'running', createdAt: 't', updatedAt: 't', activeDocumentId: 'doc-1', clientId: 'x',
  record: { status: 'running', steps: 0, trace: [], touched: [], timeline: [] }, ...over
})

const posted: Array<{ url: string; body: unknown }> = []
let listed: { runs: unknown[]; queueHeld: boolean } = { runs: [], queueHeld: false }
let nextRun: (body: { assistantMessageId: string; userMessageId: string }) => ServerRunSummary = body =>
  summary({ assistantMessageId: body.assistantMessageId, userMessageId: body.userMessageId })

let savedProvider: string
beforeEach(() => {
  posted.length = 0
  listed = { runs: [], queueHeld: false }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (data: unknown, status = 200) => ({ ok: status < 300, status, statusText: 'OK', json: async () => data }) as Response
    if (url === '/api/generate/active') return json([])
    if (url === '/api/books/book-1/runs' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      posted.push({ url, body })
      const run = nextRun(body)
      return json({ run, position: run.status === 'queued' ? 1 : 0, queueHeld: false })
    }
    if (url === '/api/books/book-1/runs') return json(listed)
    if (url.startsWith('/api/books/book-1/runs/')) { posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null }); return json({ success: true }) }
    return json({})
  }))
  savedProvider = useAppStore.getState().activeProvider
  const s = useAppStore.getState()
  useAppStore.setState({
    user: { username: 'alice' }, activeBookId: 'book-1', csrfToken: 'tok',
    documents: [doc('doc-1', '第一章', '<p>原文。</p>'), doc('doc-2', '第二章', '<p>二。</p>')],
    activeDocumentId: 'doc-1',
    messages: [{ id: 'welcome', role: 'assistant', content: 'hi', timestamp: 't' }],
    isStreaming: false, editLockedIds: null, versions: [],
    providerConfigs: { ...s.providerConfigs, grok: { ...s.providerConfigs.grok, apiKey: 'k', model: 'grok-4.6', serverRuns: true } },
    activeProvider: 'grok'
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAppStore.setState({ user: null, activeProvider: savedProvider as never, isStreaming: false, editLockedIds: null })
})

describe('a turn with serverRuns on', () => {
  it('posts the request, then renders the run: preview, record, finish', async () => {
    const stub = stubEditor('<p>原文。</p>')
    const h = renderChatHook(stub.editor)
    await act(async () => { await h.current.handleSendMessage(undefined, '写第一章') })
    await flush()
    expect(posted).toHaveLength(1)
    const body = posted[0].body as { prompt: string; activeDocumentId: string; history: unknown[]; config: { serverRuns?: boolean; apiKey: string }; provider: string }
    expect(body.prompt).toBe('写第一章')
    expect(body.activeDocumentId).toBe('doc-1')
    expect(body.history).toEqual([])
    expect(body.provider).toBe('grok')
    expect(body.config.apiKey).toBe('k')
    expect(useAppStore.getState().isStreaming).toBe(true)
    expect(bubble().agent?.run).toEqual({ id: 'run-1', status: 'running' })

    const runId = 'run-1'
    act(() => { emitRunEvent({ type: 'run', kind: 'started', runId, run: summary({ assistantMessageId: bubble().id }) }) })
    act(() => { emitRunEvent({ type: 'run', kind: 'delta', runId, text: '好的。\n<canvas><p>新' }) })
    expect(bubble().agent?.live).toBe('好的。')
    act(() => { emitRunEvent({ type: 'run', kind: 'preview', runId, documentId: 'doc-1', html: '<p>新</p>' }) })
    expect(stub.writes.at(-1)).toBe('<p>新</p>')
    act(() => { emitRunEvent({ type: 'run', kind: 'lock', runId, documentIds: ['doc-1'] }) })
    expect(isEditLocked(useAppStore.getState(), 'doc-1')).toBe(true)
    expect(isEditLocked(useAppStore.getState(), 'doc-2')).toBe(false)
    act(() => { emitRunEvent({ type: 'run', kind: 'step', runId, record: { status: 'running', steps: 1, trace: ['✏️ rewrote #1'], touched: [{ documentId: 'doc-1', titleAtRun: '第一章', kind: 'rewrite', changes: 1, failed: 0 }], timeline: [{ type: 'text', text: '好的。' }, { type: 'tool', line: '✏️ rewrote #1', ok: true }] } }) })
    expect(bubble().agent?.steps).toBe(1)
    act(() => {
      emitRunEvent({ type: 'run', kind: 'finished', runId, status: 'done', run: summary({ status: 'done', assistantMessageId: bubble().id }),
        result: { content: '好的。\n\n写完了。', record: { status: 'done', steps: 2, trace: ['✏️ rewrote #1'], touched: [{ documentId: 'doc-1', titleAtRun: '第一章', kind: 'rewrite', changes: 1, failed: 0 }], timeline: [] },
          snapshots: [{ id: 'ver-1', documentId: 'doc-1', title: 'Auto-save', timestamp: 't' }] } })
    })
    expect(useAppStore.getState().isStreaming).toBe(false)
    expect(bubble().content).toBe('好的。\n\n写完了。')
    expect(bubble().agent?.status).toBe('done')
    expect(useAppStore.getState().versions.map(v => v.id)).toContain('ver-1')
    h.unmount()
  })

  it('queues a request sent mid-turn instead of refusing it', async () => {
    const h = renderChatHook()
    await act(async () => { await h.current.handleSendMessage(undefined, '第一条') })
    await flush()
    expect(useAppStore.getState().isStreaming).toBe(true)
    nextRun = body => summary({ id: 'run-2', status: 'queued', assistantMessageId: body.assistantMessageId, userMessageId: body.userMessageId })
    await act(async () => { await h.current.handleSendMessage(undefined, '第二条') })
    await flush()
    expect(posted.filter(p => p.url === '/api/books/book-1/runs')).toHaveLength(2)
    expect(bubble().agent?.status).toBe('queued')
    expect(bubble().agent?.run?.position).toBe(1)
    // Still streaming the first; a "send now" goes to the queued run.
    expect(useAppStore.getState().isStreaming).toBe(true)
    await act(async () => { await h.current.handleRunAction('run-2', 'start') })
    expect(posted.at(-1)?.url).toBe('/api/books/book-1/runs/run-2/start')
    h.unmount()
  })

  it('stops a server run: keeps the draft on screen, tells the server, settles on its finish', async () => {
    const stub = stubEditor('<p>原文。</p>')
    const h = renderChatHook(stub.editor)
    await act(async () => { await h.current.handleSendMessage(undefined, '写') })
    await flush()
    act(() => { emitRunEvent({ type: 'run', kind: 'started', runId: 'run-1', run: summary({ assistantMessageId: bubble().id }) }) })
    act(() => { emitRunEvent({ type: 'run', kind: 'preview', runId: 'run-1', documentId: 'doc-1', html: '<p>半截</p>' }) })
    act(() => { h.current.handleStopGeneration() })
    expect(posted.at(-1)?.url).toBe('/api/books/book-1/runs/run-1/stop')
    expect(useAppStore.getState().documents.find(d => d.id === 'doc-1')?.content).toBe('<p>半截</p>')
    expect(useAppStore.getState().isStreaming).toBe(false)
    act(() => {
      emitRunEvent({ type: 'run', kind: 'finished', runId: 'run-1', status: 'stopped', run: summary({ status: 'stopped', assistantMessageId: bubble().id }),
        result: { content: '⏹️ Stopped.', record: { status: 'stopped', steps: 1, trace: [], touched: [], timeline: [] } } })
    })
    expect(bubble().content).toContain('partial draft was kept')
    h.unmount()
  })

  it('finds the book\'s running run on load and renders it into new bubbles', async () => {
    listed = { runs: [{ ...summary({ userMessageId: 'u-far', assistantMessageId: 'a-far', prompt: '远端发的' }), liveText: '正在写…', liveReasoning: '' }], queueHeld: false }
    const h = renderChatHook()
    await flush()
    await flush()
    const ids = useAppStore.getState().messages.map(m => m.id)
    expect(ids).toContain('u-far')
    expect(ids).toContain('a-far')
    expect(bubble().agent?.run).toEqual({ id: 'run-1', status: 'running' })
    expect(bubble().agent?.live).toBe('正在写…')
    expect(useAppStore.getState().isStreaming).toBe(true)
    h.unmount()
  })
})
