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

// The live previews parse their HTML into a ProseMirror slice. A real schema
// is beside the point here — what is under test is whether the preview runs at
// all — so the parser is stubbed down to "carry the html through".
vi.mock('@tiptap/pm/model', () => ({
  DOMParser: { fromSchema: () => ({ parseSlice: (el: { innerHTML: string }) => ({ size: el.innerHTML.length, html: el.innerHTML }) }) }
}))

import { useState } from 'react'
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

/**
 * An editor that mounts AFTER the hook, the way the real one does: the rejoin
 * effect runs on mount, when `activeEditor` is still null. Callbacks that
 * captured that null rendered a resumed generation into the chat bubble while
 * the document stayed blank for the whole turn.
 */
function makeFakeEditor(initialDocText = '') {
  let docText = initialDocText
  const setContentCalls: string[] = []
  // Replacements applied through the selection preview path.
  const replacements: Array<{ from: number; to: number; html: string }> = []
  const tr = {
    replace: (from: number, to: number, slice: { html: string }) => { replacements.push({ from, to, html: slice.html }) }
  }
  const chain = {
    setMeta: () => chain,
    setContent: (html: string) => { setContentCalls.push(html); return chain },
    run: () => true
  }
  return {
    setContentCalls,
    replacements,
    /** The server sync landing after the editor mounted. */
    setDocText: (text: string) => { docText = text },
    editor: {
      chain: () => chain,
      getHTML: () => '',
      state: {
        // One text node, so collectTextSpans can locate a resumed selection.
        doc: {
          content: { size: 100 },
          descendants: (fn: (n: { isText: boolean; text: string }, pos: number) => void) => {
            if (docText) fn({ isText: true, text: docText }, 1)
          }
        },
        schema: {},
        selection: { from: 0, to: 0 },
        tr
      },
      view: { dispatch: () => {} }
    } as never
  }
}

function renderChatHookWithLateEditor(initialDocText = '') {
  const container = document.createElement('div')
  const fake = makeFakeEditor(initialDocText)
  let root: Root
  let setEditor: (e: unknown) => void = () => {}
  const Probe = () => {
    const [editor, setEditorState] = useState<unknown>(null)
    setEditor = setEditorState
    useChatLLM({
      activeEditor: editor as never,
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
  return {
    fake,
    mountEditor: () => act(() => { setEditor(fake.editor) }),
    unmount: () => act(() => root.unmount())
  }
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

  it('streams a resumed generation into the document, not only the bubble', async () => {
    // The editor mounts after the hook — the real order, and the reason the
    // rejoin's callbacks used to hold a null editor for the whole turn.
    let emit: ((chunk: string) => void) | null = null
    let finish: ((text: string) => void) | null = null
    findResumableJob.mockResolvedValue({ jobId: 'gen-live', meta: { assistantMessageId: 'a-1', kind: 'chat' }, offset: 0 })
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      emit = callbacks.onChunk
      finish = callbacks.onDone
      await new Promise(r => setTimeout(r, 0))
    })

    const h = renderChatHookWithLateEditor()
    await settle()
    h.mountEditor()

    const partial = 'Working.\n<canvas><h1>重连测试</h1><p>第一段。</p>'
    await act(async () => { emit?.(partial) })

    // The document preview must have received the replayed canvas.
    expect(h.fake.setContentCalls.length).toBeGreaterThan(0)
    expect(h.fake.setContentCalls.join('')).toContain('重连测试')

    await act(async () => { finish?.(partial + '</canvas>\n<doc_status>updated</doc_status>') })
    h.unmount()
  })

  it('applies a tool call replayed to a resumed turn', async () => {
    // The server replays the whole call on attach; if the rejoin forwards only
    // onChunk/onDone/onError, that replay lands on a listener that does not
    // exist and the document never changes — which is what "refresh loses it"
    // looked like from outside.
    findResumableJob.mockResolvedValue({ jobId: 'gen-tool', meta: { assistantMessageId: 'a-1', kind: 'chat' }, offset: 0 })
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      callbacks.onToolCallDelta?.({
        index: 0,
        name: 'update_document',
        argumentsText: '{"html": "<p>REPLAYED_TOOL_CALL</p>"}',
        replace: true
      })
      callbacks.onDone('')
    })

    const unmount = renderChatHook()
    await settle()

    expect(activeContent()).toContain('REPLAYED_TOOL_CALL')
    expect(useAppStore.getState().isStreaming).toBe(false)
    unmount()
  })

  it('applies a replayed selection rewrite by relocating the text', async () => {
    // The most common way this app is used: select a passage, ask for a
    // rewrite, refresh mid-generation. The selection RANGE died with the tab,
    // so the persisted selected TEXT has to find it again.
    useAppStore.setState({
      documents: [{
        id: 'doc-1',
        title: 'Chapter 1',
        content: '<p>keep this</p><p>选中的原文</p><p>and this</p>',
        createdAt: '', updatedAt: ''
      }] as never,
      activeDocumentId: 'doc-1'
    })
    findResumableJob.mockResolvedValue({
      jobId: 'gen-sel',
      meta: { assistantMessageId: 'a-1', kind: 'chat', selectedText: '选中的原文' },
      offset: 0
    })
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      callbacks.onToolCallDelta?.({
        index: 0,
        name: 'replace_selection',
        argumentsText: '{"html": "<p>REWRITTEN_SELECTION</p>"}',
        replace: true
      })
      callbacks.onDone('')
    })

    const unmount = renderChatHook()
    await settle()

    // Without an editor the store cannot be rewritten in place, but the
    // selection must at least have been RELOCATED rather than reported gone.
    expect(bubble('a-1')).not.toContain('no longer where it was')
    expect(useAppStore.getState().isStreaming).toBe(false)
    unmount()
  })

  it('previews a replayed MARKUP selection rewrite, not just the tool one', async () => {
    // The regression: relocating a resumed selection was wired into the
    // tool-call preview and the final apply, but NOT into the markup chunk
    // preview. On the markup protocol (what grok is on, because it sends tool
    // arguments in one chunk) `selectionRange` stayed null for the whole
    // rejoined turn, so the guard below it skipped every preview — the user
    // saw the diff appear at the end and nothing before it.
    findResumableJob.mockResolvedValue({
      jobId: 'gen-markup-sel',
      meta: { assistantMessageId: 'a-1', kind: 'chat', selectedText: '选中的原文' },
      offset: 0
    })
    let emit: (chunk: string) => void = () => {}
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      emit = (chunk: string) => callbacks.onChunk(chunk)
    })

    const { fake, mountEditor, unmount } = renderChatHookWithLateEditor('选中的原文')
    await settle()
    mountEditor()

    // Arriving in fragments, the way content deltas actually do.
    await act(async () => { emit('<selection_replace><p>改写第一') })
    await act(async () => { emit('段落</p></selection_replace>') })

    expect(fake.replacements.length).toBeGreaterThan(0)
    expect(fake.replacements[0].html).toContain('改写第一')
    unmount()
  })

  it('keeps previewing once the document finishes loading, and still applies', async () => {
    // The regression this guards: on a reload the editor mounts BEFORE the
    // server sync fills it, so the first chunks search an empty document. When
    // a failed lookup consumed the pending selection text anyway, everything
    // downstream was lost — no preview for the rest of the turn, and no diff
    // at the end either, because the apply had nothing left to relocate with.
    findResumableJob.mockResolvedValue({
      jobId: 'gen-late-doc',
      meta: { assistantMessageId: 'a-1', kind: 'chat', selectedText: '选中的原文' },
      offset: 0
    })
    let emit: (chunk: string) => void = () => {}
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      emit = (chunk: string) => callbacks.onChunk(chunk)
    })

    // Mounts with an EMPTY document, the way a cold reload does.
    const { fake, mountEditor, unmount } = renderChatHookWithLateEditor('')
    await settle()
    mountEditor()

    await act(async () => { emit('<selection_replace><p>改写') })
    expect(fake.replacements).toHaveLength(0)   // nothing to relocate against yet

    fake.setDocText('选中的原文')               // the sync lands
    await act(async () => { emit('第一段落</p></selection_replace>') })

    expect(fake.replacements.length).toBeGreaterThan(0)
    expect(fake.replacements[0].html).toContain('改写')
    unmount()
  })

  it('never empties a chapter whose content had not finished loading', async () => {
    // The data-loss bug, end to end. After a cold reload the chapter is in the
    // store as metadata with `content: ''` until its fetch lands. The rejoin
    // captured that as its "leave it as it was" base, every <edit> block then
    // failed to match an empty document, and the completion path wrote the
    // base back — replacing a chapter of prose with nothing, auto-saved, with
    // no version snapshot behind it (the rejoin path takes none: it does not
    // send, and snapshots are taken at send time).
    const PROSE = '<p>三千字的正文，还没加载完就被当成了基准。</p>'
    let fetched = false
    useAppStore.setState({
      documents: [{
        id: 'doc-1', title: 'Chapter 1',
        content: '',                     // lazy: metadata only, so far
        contentLoaded: false,
        createdAt: '', updatedAt: ''
      }] as never,
      activeDocumentId: 'doc-1',
      ensureDocumentContents: (async () => {
        fetched = true
        useAppStore.setState(st => ({
          documents: st.documents.map(d => d.id === 'doc-1' ? { ...d, content: PROSE, contentLoaded: true } : d)
        }))
      }) as never
    })

    findResumableJob.mockResolvedValue({ jobId: 'gen-lazy', meta: { assistantMessageId: 'a-1', kind: 'chat' }, offset: 0 })
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      // An edit whose SEARCH cannot be found — exactly what an empty base
      // guarantees, and what the user saw reported as "skipped".
      callbacks.onChunk(
        '已把进门这一段再拉开。\n<edit>\n<<<<<<< SEARCH\n<p>一段并不存在于空文档里的原文</p>\n=======\n<p>改写后的段落</p>\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>'
      )
      callbacks.onDone(
        '已把进门这一段再拉开。\n<edit>\n<<<<<<< SEARCH\n<p>一段并不存在于空文档里的原文</p>\n=======\n<p>改写后的段落</p>\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>'
      )
    })

    const unmount = renderChatHook()
    await settle()
    await settle()

    expect(fetched).toBe(true)              // the base was loaded before use
    expect(activeContent()).toBe(PROSE)     // and the chapter survived
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
