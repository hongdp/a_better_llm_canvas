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
const findJobsForBubbles = vi.fn()
const resumeRemoteGeneration = vi.fn()

vi.mock('../../services/remoteGeneration', () => ({
  findResumableJob: (...a: unknown[]) => findResumableJob(...a),
  findJobsForBubbles: (...a: unknown[]) => findJobsForBubbles(...a),
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
import { hashContent } from '../../utils/contextLedger'
import { stripDiffMarkup } from '../../utils/diff'
import { useAppStore } from '../../store/useAppStore'
import { INTERRUPTED_NOTICE, RECONNECT_FAILED_NOTICE } from '../chat/streamHandlers'

// One case replaces this store ACTION through setState. Resetting state does
// not undo that, so without the restore in beforeEach its stub leaked into
// every later test and quietly rewrote their document.
const realEnsureDocumentContents = useAppStore.getState().ensureDocumentContents

/** What the server says about the jobs behind a set of bubbles. */
const serverKnows = (jobs: Record<string, { jobId: string; status?: string; meta?: Record<string, unknown> }>) =>
  ({ known: true, jobs: new Map(Object.entries(jobs).map(([id, j]) => [id, { status: 'running', ...j }])) })

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
  // Mirrors the real Transaction shape the selection helper relies on:
  // replace() chains, and mapping.map() reports where a position ended up.
  const tr = {
    mapping: { map: (pos: number) => pos },
    replace(from: number, to: number, slice: { html: string }): unknown {
      replacements.push({ from, to, html: slice.html })
      return tr
    }
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
  // Default: the server can be asked, and holds no job for any bubble.
  findJobsForBubbles.mockReset()
  findJobsForBubbles.mockResolvedValue(serverKnows({}))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  useAppStore.setState({
    ensureDocumentContents: realEnsureDocumentContents,
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
    // A write hands its result back, so the turn would have gone on: the
    // bubble says the reload stopped it rather than ending in silence.
    expect(bubble('a-1')).toBe('Continued.\n\nℹ️ The page reloaded during this turn, so it stopped after the step that was running. Reply "continue" to go on.')
    expect(activeContent()).toContain('RESUMED_TEXT')
    expect(activeContent()).toContain('diff-addition')
    expect(useAppStore.getState().isStreaming).toBe(false)
    unmount()
  })

  it('continues the bubble\'s record of the steps before the reload instead of replacing it', async () => {
    // Reported 2026-10-06: a reload at chapter 19 left a 19-chapter turn
    // showing one trace line and "steps: 1".
    useAppStore.setState({
      messages: [
        { id: 'u-1', role: 'user', content: 'write the chapters', timestamp: '2026-07-01T00:00:00.000Z' },
        {
          id: 'a-1', role: 'assistant', content: 'Chapter one done.', timestamp: '2026-07-01T00:00:00.000Z',
          agent: {
            status: 'running', steps: 2,
            trace: ['➕ create #2 "Ch1"', '✏️ rewrote #2 "Ch1"'],
            touched: [{ documentId: 'doc-1', titleAtRun: 'Ch1', kind: 'rewrite', changes: 1, failed: 0 }],
            timeline: [{ type: 'text', text: 'Chapter one done.' }, { type: 'tool', line: '✏️ rewrote #2 "Ch1"', ok: true }],
            live: 'half a sentence'
          }
        }
      ]
    })
    findResumableJob.mockResolvedValue({ jobId: 'gen-1', meta: { assistantMessageId: 'a-1', kind: 'chat' }, offset: 0 })
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      const text = 'Chapter two.\n<canvas><p>RESUMED_TEXT</p></canvas>\n<doc_status>updated</doc_status>'
      callbacks.onChunk(text)
      callbacks.onDone(text)
    })

    const unmount = renderChatHook()
    await settle()

    const msg = useAppStore.getState().messages.find(m => m.id === 'a-1')
    expect(msg?.agent).toMatchObject({
      status: 'stopped',
      steps: 3,
      trace: ['➕ create #2 "Ch1"', '✏️ rewrote #2 "Ch1"', expect.stringContaining('rewrote')],
      touched: [{ documentId: 'doc-1', changes: 2 }]
    })
    expect(msg?.agent?.timeline?.map(i => i.type === 'text' ? i.text : 'tool')).toEqual(['Chapter one done.', 'tool', 'Chapter two.', 'tool'])
    expect(msg?.agent?.live).toBeUndefined()
    expect(msg?.content).toContain('Chapter one done.\n\nChapter two.')
    expect(msg?.content).toContain('The page reloaded during this turn')
    unmount()
  })

  describe('remembers what the model read before the reload', () => {
    // 2026-10-06, "继续写第二章": the step before the reload read chapter 2's
    // HTML; the rejoined step's edit of it was refused as "not read yet".
    const CH2 = '<p>第二章旧句。</p>'
    const setup = (seenContent: string) => {
      useAppStore.setState({
        documents: [
          ...useAppStore.getState().documents,
          { id: 'doc-2', title: '第二章', content: CH2, contentLoaded: true, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }
        ],
        messages: [
          { id: 'u-1', role: 'user', content: '扩写第二章', timestamp: '2026-07-01T00:00:00.000Z' },
          {
            id: 'a-1', role: 'assistant', content: '先读第二章。', timestamp: '2026-07-01T00:00:00.000Z',
            agent: {
              status: 'running', steps: 1, trace: ['📖 read #2 "第二章" (html)'], touched: [],
              seen: [{ id: 'doc-2', hash: hashContent(seenContent) }]
            }
          }
        ]
      })
      findResumableJob.mockResolvedValue({ jobId: 'gen-1', meta: { assistantMessageId: 'a-1', kind: 'chat' }, offset: 0 })
      resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
        const text = '扩写。\n<edit chapter="2">\n<<<<<<< SEARCH\n<p>第二章旧句。</p>\n=======\n<p>第二章新句，更长。</p>\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>'
        callbacks.onChunk(text)
        callbacks.onDone(text)
      })
    }
    const ch2 = () => useAppStore.getState().documents.find(d => d.id === 'doc-2')?.content ?? ''

    it('applies the rejoined step\'s edit of a chapter read before the reload', async () => {
      setup(CH2)
      const unmount = renderChatHook()
      await settle()
      expect(stripDiffMarkup(ch2())).toBe('<p>第二章新句，更长。</p>')
      expect(useAppStore.getState().messages.find(m => m.id === 'a-1')?.agent?.trace.at(-1)).not.toContain('not read yet')
      unmount()
    })

    it('does not count a chapter the user changed since it was read', async () => {
      setup('<p>what the model saw, before the user edited it</p>')
      const unmount = renderChatHook()
      await settle()
      expect(ch2()).toBe(CH2)
      expect(useAppStore.getState().messages.find(m => m.id === 'a-1')?.agent?.trace.at(-1)).toContain('not read yet')
      unmount()
    })
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
    expect(bubble('a1')).toBe(RECONNECT_FAILED_NOTICE)
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


// ── the server is the source of truth, not this browser's record ─────────────
// The job record is one localStorage slot on one origin. A turn sent from
// another device — or over the LAN address instead of localhost, or followed
// by any other generation — has none here. It used to be declared
// "Interrupted" while its job was running, and the reply then landed nowhere.
describe('reconciling unfinished bubbles with the server', () => {
  it('rejoins a running job this browser holds no record of', async () => {
    findResumableJob.mockResolvedValue(null)
    findJobsForBubbles.mockResolvedValue(serverKnows({
      'a-1': { jobId: 'gen-elsewhere', meta: { assistantMessageId: 'a-1', kind: 'chat', bookId: 'book-test' } }
    }))
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      callbacks.onChunk('From the other device.')
      callbacks.onDone('From the other device.')
    })

    const unmount = renderChatHook()
    await settle()

    expect(findJobsForBubbles).toHaveBeenCalledWith(['a-1'], 'book-test')
    expect(resumeRemoteGeneration.mock.calls[0][0]).toBe('gen-elsewhere')
    // The meta is handed over so the transport can write a record of its own.
    expect(resumeRemoteGeneration.mock.calls[0][4]).toMatchObject({ assistantMessageId: 'a-1' })
    expect(bubble('a-1')).toBe('From the other device.')
    unmount()
  })

  it('never retires a bubble when the server could not be asked', async () => {
    // "Could not ask" is not "no job": the backend may be restarting, the
    // phone may be between networks. Guessing here destroyed live turns.
    findResumableJob.mockResolvedValue(null)
    findJobsForBubbles.mockResolvedValue({ known: false })

    const unmount = renderChatHook()
    await settle()

    expect(bubble('a-1')).toBe('Thinking...')
    expect(resumeRemoteGeneration).not.toHaveBeenCalled()
    unmount()
  })

  it('lets the reply land in a bubble an earlier load had already written off', async () => {
    useAppStore.setState({
      messages: [{ id: 'a-1', role: 'assistant', content: INTERRUPTED_NOTICE, timestamp: 't' }]
    })
    findResumableJob.mockResolvedValue(null)
    findJobsForBubbles.mockResolvedValue(serverKnows({
      'a-1': { jobId: 'gen-late', status: 'done', meta: { assistantMessageId: 'a-1', kind: 'chat' } }
    }))
    resumeRemoteGeneration.mockImplementation(async (_id: string, _from: number, callbacks: StreamCallbacks) => {
      callbacks.onChunk('It finished after all.')
      callbacks.onDone('It finished after all.')
    })

    const unmount = renderChatHook()
    await settle()

    expect(bubble('a-1')).toBe('It finished after all.')
    unmount()
  })

  it('asks the server nothing when no bubble is unfinished', async () => {
    useAppStore.setState({
      messages: [{ id: 'a-1', role: 'assistant', content: 'A complete reply.', timestamp: 't' }]
    })
    findResumableJob.mockResolvedValue(null)

    const unmount = renderChatHook()
    await settle()

    expect(findJobsForBubbles).not.toHaveBeenCalled()
    expect(bubble('a-1')).toBe('A complete reply.')
    unmount()
  })

  it('falls back to the server when the local record names a non-chat job', async () => {
    findResumableJob.mockResolvedValue({ jobId: 'gen-rp', meta: { kind: 'roleplay' }, offset: 0 })
    findJobsForBubbles.mockResolvedValue(serverKnows({
      'a-1': { jobId: 'gen-chat', meta: { assistantMessageId: 'a-1', kind: 'chat' } }
    }))

    const unmount = renderChatHook()
    await settle()

    expect(resumeRemoteGeneration.mock.calls[0][0]).toBe('gen-chat')
    unmount()
  })
})

// ── the watchdog measured the model, not the connection ──────────────────────
// Reported from a live turn (grok, 230s to first token): the rejoin attached
// fine, received `attached` and `reasoning` frames and nothing else, and was
// aborted at 20s as "dead". The abort surfaced as an AbortError — which reads
// as a USER stop — so the bubble said "Stopped." for a job nobody stopped,
// which then finished (9406 chars) with no reader left to render it.
describe('rejoin watchdog', () => {
  const liveJob = { jobId: 'gen-slow', meta: { assistantMessageId: 'a-1', kind: 'chat' as const }, offset: 0 }

  it('does not mistake a turn that is still reasoning for a dead one', async () => {
    vi.useFakeTimers()
    findResumableJob.mockResolvedValue(liveJob)
    let finish: () => void = () => {}
    let signal: AbortSignal | undefined
    resumeRemoteGeneration.mockImplementation((_id: string, _from: number, callbacks: StreamCallbacks, sig: AbortSignal) => {
      signal = sig
      callbacks.onAttached?.()
      callbacks.onReasoning?.('weighing the options')
      return new Promise<void>(resolve => {
        finish = () => { callbacks.onChunk('Worth the wait.'); callbacks.onDone('Worth the wait.'); resolve() }
      })
    })

    const unmount = renderChatHook()
    await settle()
    // Four minutes of thinking — eleven times the old 20s verdict.
    await act(async () => { vi.advanceTimersByTime(240_000) })
    await settle()

    expect(signal?.aborted).toBe(false)
    expect(bubble('a-1')).not.toContain('Stopped')
    expect(useAppStore.getState().isStreaming).toBe(true)

    await act(async () => { finish() })
    await settle()
    expect(bubble('a-1')).toBe('Worth the wait.')
    expect(useAppStore.getState().isStreaming).toBe(false)
    vi.useRealTimers()
    unmount()
  })

  it('reports a rejoin that cannot attach as a reconnect failure, never as a user stop', async () => {
    vi.useFakeTimers()
    findResumableJob.mockResolvedValue(liveJob)
    // A fetch that hangs: no frame ever arrives. When aborted, the transport
    // reports the AbortError through onError, exactly as attachToJob does.
    resumeRemoteGeneration.mockImplementation((_id: string, _from: number, callbacks: StreamCallbacks, sig: AbortSignal) =>
      new Promise<void>(resolve => {
        sig.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.')
          err.name = 'AbortError'
          callbacks.onError(err)
          resolve()
        })
      }))

    const unmount = renderChatHook()
    await settle()
    const before = activeContent()
    await act(async () => { vi.advanceTimersByTime(20_001) })
    await settle()

    expect(bubble('a-1')).toBe(RECONNECT_FAILED_NOTICE)
    expect(bubble('a-1')).not.toContain('Stopped')
    expect(useAppStore.getState().isStreaming).toBe(false)
    // The document is untouched: nothing was "kept as a draft" on the user's behalf.
    expect(activeContent()).toBe(before)
    expect(before).toBe('<p>old text</p>')
    vi.useRealTimers()
    unmount()
  })
})
