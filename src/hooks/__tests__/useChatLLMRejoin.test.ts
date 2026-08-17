/**
 * Rejoin wiring test: a generation that outlived the tab must stream back
 * into the SAME assistant bubble and apply its document update, exactly as if
 * the tab had never gone away (resumable_generation.md §5).
 *
 * The transport is mocked at the module boundary; what is under test is the
 * hook's mount effect and the fact that it reuses the normal render path
 * (bubble text, <canvas> extraction, diff, streaming flag).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StreamCallbacks } from '../../types/llm'

const findResumableJob = vi.fn()
const resumeRemoteGeneration = vi.fn()

vi.mock('../../services/remoteGeneration', () => ({
  findResumableJob: (...a: unknown[]) => findResumableJob(...a),
  resumeRemoteGeneration: (...a: unknown[]) => resumeRemoteGeneration(...a),
  abortRemoteGeneration: vi.fn(),
  clearPersistedJob: vi.fn()
}))

// The rejoin never starts a new request; a no-op keeps the direct transport
// (and its provider fetches) out of this test entirely.
vi.mock('../../services/llm', () => ({ streamLLM: vi.fn() }))
vi.mock('../../services/chapterSummaries', () => ({ enqueueStaleSummaryRefreshes: vi.fn() }))

import { useChatLLM } from '../useChatLLM'
import { useAppStore } from '../../store/useAppStore'

function renderChatHook() {
  const container = document.createElement('div')
  let root: Root
  const Probe = () => {
    useChatLLM({
      activeEditor: null,
      selectedText: '',
      uploadedImages: [],
      setUploadedImages: vi.fn(),
      layoutMode: 'landscape',
      setIsChatExpanded: vi.fn(),
      forceSave: vi.fn(),
      setSaveStatus: vi.fn()
    })
    return null
  }
  act(() => {
    root = createRoot(container)
    root.render(createElement(Probe))
  })
  return () => act(() => root.unmount())
}

/** Let the mount effect's awaits (findResumableJob → resume) settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
}

const bubble = (id: string) => useAppStore.getState().messages.find(m => m.id === id)?.content
const activeContent = () => {
  const s = useAppStore.getState()
  return s.documents.find(d => d.id === s.activeDocumentId)?.content ?? ''
}

beforeEach(() => {
  findResumableJob.mockReset()
  resumeRemoteGeneration.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  useAppStore.setState({
    documents: [{
      id: 'doc-1',
      title: 'Chapter 1',
      content: '<p>old text</p>',
      contentLoaded: true,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z'
    }],
    activeDocumentId: 'doc-1',
    messages: [
      { id: 'u-1', role: 'user', content: 'write chapter 2', timestamp: '2026-07-01T00:00:00.000Z' },
      { id: 'a-1', role: 'assistant', content: 'Thinking...', timestamp: '2026-07-01T00:00:00.000Z' }
    ],
    versions: [],
    isStreaming: false,
    user: { username: 'alice' },
    activeBookId: 'book-test',
    agenticLookupEnabled: false,
    wholeBookMode: 'off',
    pinnedReferenceIds: [],
    blockedReferenceIds: [],
    debugMode: false,
    activeSystemPromptId: 'prompt-none',
    customSystemPrompts: [{ id: 'prompt-none', name: 'None', content: '' }]
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState({ user: null })
})

describe('useChatLLM — rejoin after the tab was discarded', () => {
  it('streams a resumed job into the existing bubble and applies its document update', async () => {
    findResumableJob.mockResolvedValue({ jobId: 'gen-1', meta: { assistantMessageId: 'a-1', kind: 'chat' }, offset: 7 })
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      const text = 'Continued.\n<canvas><h1>Ch2</h1><p>RESUMED_TEXT</p></canvas>'
      callbacks.onChunk(text)
      callbacks.onDone(text)
    })

    const unmount = renderChatHook()
    await settle()

    expect(resumeRemoteGeneration).toHaveBeenCalledTimes(1)
    expect(resumeRemoteGeneration.mock.calls[0][0]).toBe('gen-1')
    // The bubble is reused, not duplicated, and the document update lands as a
    // reviewable diff through the normal completion path.
    expect(useAppStore.getState().messages).toHaveLength(2)
    expect(bubble('a-1')).toBe('Continued.')
    expect(activeContent()).toContain('RESUMED_TEXT')
    expect(activeContent()).toContain('diff-addition')
    expect(useAppStore.getState().isStreaming).toBe(false)
    unmount()
  })

  it('explains a resumed reply that wrote nothing, instead of going silent', async () => {
    // A rejoined turn has no request to replay, so the usual retry cannot run.
    // Without a message the user just sees a stream end and a document that
    // never changed — the exact "it finished and nothing happened" report.
    findResumableJob.mockResolvedValue({ jobId: 'gen-mute', meta: { assistantMessageId: 'a-1', kind: 'chat' }, offset: 0 })
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      // Says it rewrote the chapter, emits no markup: content the user
      // watched stream that reached the document as nothing.
      const text = '已经帮你把这一段扩写好了。\n<doc_status>updated</doc_status>'
      callbacks.onChunk(text)
      callbacks.onDone(text)
    })

    const unmount = renderChatHook()
    await settle()

    expect(bubble('a-1')).toContain('⚠️')
    expect(bubble('a-1')).toContain('no usable document update')
    expect(useAppStore.getState().isStreaming).toBe(false)
    unmount()
  })

  it('retires a placeholder whose job is gone instead of leaving it "Thinking..."', async () => {
    // Nothing is generating, so the bubble must not keep reading as if it
    // were: every path that would have cleared it died with the page, and the
    // user is left staring at a turn that will never finish.
    findResumableJob.mockResolvedValue(null)

    const unmount = renderChatHook()
    await settle()

    expect(resumeRemoteGeneration).not.toHaveBeenCalled()
    expect(bubble('a-1')).toContain('Interrupted')
    expect(bubble('a-1')).not.toBe('Thinking...')
    expect(useAppStore.getState().isStreaming).toBe(false)
    unmount()
  })

  it('leaves a placeholder alone while its job is being rejoined', async () => {
    findResumableJob.mockResolvedValue({ jobId: 'gen-live', meta: { assistantMessageId: 'a-1', kind: 'chat' }, offset: 0 })

    const unmount = renderChatHook()
    await settle()

    expect(resumeRemoteGeneration).toHaveBeenCalled()
    expect(bubble('a-1')).not.toContain('Interrupted')
    unmount()
  })

  it('skips a job whose assistant bubble no longer exists', async () => {
    findResumableJob.mockResolvedValue({ jobId: 'gen-2', meta: { assistantMessageId: 'gone', kind: 'chat' }, offset: 0 })
    vi.useFakeTimers()

    const unmount = renderChatHook()
    await settle()
    // The wait for a late-arriving history gives up rather than hanging.
    await act(async () => { vi.advanceTimersByTime(20_000) })
    await settle()

    expect(resumeRemoteGeneration).not.toHaveBeenCalled()
    expect(useAppStore.getState().isStreaming).toBe(false)
    vi.useRealTimers()
    unmount()
  })

  it('waits for the chat history to arrive from the server sync', async () => {
    useAppStore.setState({ messages: [] }) // cold reload: sync has not landed yet
    findResumableJob.mockResolvedValue({ jobId: 'gen-3', meta: { assistantMessageId: 'a-1', kind: 'chat' }, offset: 0 })
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      callbacks.onChunk('Back.')
      callbacks.onDone('Back.')
    })

    const unmount = renderChatHook()
    await settle()
    expect(resumeRemoteGeneration).not.toHaveBeenCalled()

    // The server sync restores the conversation a moment later.
    await act(async () => {
      useAppStore.setState({
        messages: [{ id: 'a-1', role: 'assistant', content: 'Thinking...', timestamp: '2026-07-01T00:00:00.000Z' }]
      })
    })
    await settle()

    expect(resumeRemoteGeneration).toHaveBeenCalledTimes(1)
    expect(bubble('a-1')).toBe('Back.')
    unmount()
  })
})

// ── the stuck-"streaming" regression ─────────────────────────────────────────
// Reported from the device: after a reload mid-generation the header said
// "… is streaming changes" forever while nothing arrived. setStreaming(true)
// sat before an unguarded await, so a throw (expired job, restarted server,
// 404 stream) escaped as an unhandled rejection and never cleared the flag.
describe('rejoin failure handling', () => {
  it('clears the streaming flag when the resume throws', async () => {
    useAppStore.setState({
      messages: [{ id: 'a1', role: 'assistant', content: 'Thinking...', timestamp: 't' }],
      isStreaming: false
    })
    findResumableJob.mockResolvedValue({ jobId: 'gen-1', meta: { kind: 'chat', assistantMessageId: 'a1' }, offset: 0 })
    resumeRemoteGeneration.mockRejectedValue(new Error('Generation stream failed (404): Not Found'))

    const unmount = renderChatHook()
    await settle()

    expect(useAppStore.getState().isStreaming).toBe(false)
    expect(bubble('a1')).toContain('could not be resumed')
    unmount()
  })

  it('leaves an already-rendered reply untouched when the resume throws', async () => {
    useAppStore.setState({
      messages: [{ id: 'a2', role: 'assistant', content: 'partial answer so far', timestamp: 't' }],
      isStreaming: false
    })
    findResumableJob.mockResolvedValue({ jobId: 'gen-2', meta: { kind: 'chat', assistantMessageId: 'a2' }, offset: 5 })
    resumeRemoteGeneration.mockRejectedValue(new Error('boom'))

    const unmount = renderChatHook()
    await settle()

    expect(useAppStore.getState().isStreaming).toBe(false)
    expect(bubble('a2')).toBe('partial answer so far')
    unmount()
  })
})
