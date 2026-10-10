/**
 * Flow tests for the chat orchestration hook.
 *
 * `startLLMStreaming` has two re-entrant paths that drive the SAME assistant
 * bubble: the no-action retry and normal completion. Each re-issues the request through a ref, so a
 * mistake shows up as a duplicated bubble, a lost document update, or an
 * unbounded loop — none of which the pure unit tests can see. These tests
 * drive the real hook against a scripted `streamLLM` and assert on the store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LLMMessage } from '../../types/llm'

// ── Scripted LLM ──────────────────────────────────────────────────────────────
// Each entry is one complete response; calls record what the hook sent.
type ScriptedToolDelta = { index: number; name?: string; argumentsText: string }
type ScriptedResponse =
  | string
  | { chunks: string[]; error?: string }
  | { text: string; toolCalls: ScriptedToolDelta[] }
const responses: ScriptedResponse[] = []
const calls: LLMMessage[][] = []

vi.mock('../../services/llm', () => ({
  streamLLM: async (
    messages: LLMMessage[],
    _config: unknown,
    callbacks: {
      onChunk: (c: string) => void
      onDone: (t: string, u?: { promptTokens: number; completionTokens: number }) => void
      onError: (e: Error) => void
      onToolCallDelta?: (d: { index: number; id?: string; name?: string; argumentsText: string }) => void
    }
  ) => {
    calls.push(messages)
    // Past the script, the model closes the turn with no action — writes
    // hand their result back now, so every write is followed by this reply.
    const scripted = responses.shift() ?? '<doc_status>unchanged</doc_status>'
    if (typeof scripted === 'string') {
      callbacks.onChunk(scripted)
      callbacks.onDone(scripted, { promptTokens: 10, completionTokens: 20 })
      return
    }
    if ('toolCalls' in scripted) {
      // A tool-calling turn: prose (if any) on the content channel, the call
      // itself as argument deltas — the shape every provider streams.
      if (scripted.text) callbacks.onChunk(scripted.text)
      for (const delta of scripted.toolCalls) {
        callbacks.onToolCallDelta?.(delta)
        vi.setSystemTime(Date.now() + 300)
      }
      callbacks.onDone(scripted.text, { promptTokens: 10, completionTokens: 20 })
      return
    }
    let full = ''
    for (const chunk of scripted.chunks) {
      full += chunk
      callbacks.onChunk(chunk)
      // The preview is time-throttled; let each chunk land in its own window.
      vi.setSystemTime(Date.now() + 300)
    }
    if (scripted.error) {
      callbacks.onError(new Error(scripted.error))
      return
    }
    callbacks.onDone(full, { promptTokens: 10, completionTokens: 20 })
  }
}))

// Background summarization is fire-and-forget and irrelevant here.
vi.mock('../../services/chapterSummaries', () => ({
  enqueueStaleSummaryRefreshes: vi.fn()
}))

import { useChatLLM } from '../useChatLLM'
import { useAppStore } from '../../store/useAppStore'

// ── Minimal hook harness (no @testing-library dependency) ────────────────────
interface Harness {
  current: ReturnType<typeof useChatLLM>
  unmount: () => void
}

function renderChatHook(editor: unknown = null): Harness {
  const harness = { current: null as unknown as ReturnType<typeof useChatLLM> } as Harness
  const Probe = () => {
    harness.current = useChatLLM({
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
  const container = document.createElement('div')
  let root: Root
  act(() => {
    root = createRoot(container)
    root.render(createElement(Probe))
  })
  harness.unmount = () => act(() => root.unmount())
  return harness
}

/**
 * Minimal stand-in for the TipTap editor: records every chained
 * setMeta/setContent the live <canvas> preview performs, and reports the last
 * HTML written back as getHTML() (which is what the hook compares against).
 */
function stubEditor() {
  const writes: string[] = []
  const meta: unknown[] = []
  /** Per write: whether the undo history recorded it (no addToHistory:false). */
  const recorded: boolean[] = []
  let html = '<p>old text</p>'
  let pendingAddToHistory: unknown = undefined
  const chain = {
    setMeta: (_k: string, v: unknown) => { meta.push(v); pendingAddToHistory = v; return chain },
    setContent: (c: string) => {
      writes.push(c)
      recorded.push(pendingAddToHistory !== false)
      pendingAddToHistory = undefined
      html = c
      return chain
    },
    run: () => true
  }
  return {
    writes,
    meta,
    recorded,
    editor: {
      chain: () => chain,
      getHTML: () => html,
      commands: { setContent: (c: string) => { writes.push(c); recorded.push(true); html = c } },
      state: { selection: { from: 0, to: 0 } }
    }
  }
}

const doc = (id: string, title: string, content: string) => ({
  id,
  title,
  content,
  contentLoaded: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
})

const activeContent = () => {
  const s = useAppStore.getState()
  return s.documents.find(d => d.id === s.activeDocumentId)?.content ?? ''
}

const assistantBubble = () => {
  const msgs = useAppStore.getState().messages
  return msgs.filter(m => m.role === 'assistant').map(m => m.content)
}

/** The final user message of a recorded request — where the volatile context sits. */
/** The model's reply with no action, which closes a turn that wrote. */
const CLOSE = '<doc_status>unchanged</doc_status>'

const finalUserContent = (callIndex: number) => {
  const msgs = calls[callIndex]
  return msgs[msgs.length - 1].content
}

const send = async (harness: Harness, prompt: string) => {
  await act(async () => {
    await harness.current.handleSendMessage(undefined, prompt)
  })
  // The retry continuation is dispatched with `void` inside onDone;
  // let those microtasks (and the scripted stream they drive) settle.
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] })
  responses.length = 0
  calls.length = 0
  // jsdom has no IndexedDB; the store's debounced save logs and moves on.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  useAppStore.setState({
    documents: [doc('doc-1', 'Chapter 1', '<p>old text</p>')],
    activeDocumentId: 'doc-1',
    messages: [],
    versions: [],
    isStreaming: false,
    user: null,
    activeBookId: 'book-test',
    debugMode: false,
    activeSystemPromptId: 'prompt-none',
    customSystemPrompts: [{ id: 'prompt-none', name: 'None', content: '' }]
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useChatLLM — history past the window', () => {
  it('summarizes the dropped prefix with one call and sends the note ahead of the kept tail', async () => {
    const s = useAppStore.getState()
    const model = s.providerConfigs[s.activeProvider].model
    // A window small enough that eight turns of prose cannot fit.
    useAppStore.setState({
      discoveredContextWindows: { ...s.discoveredContextWindows, [model]: 8_000 },
      messages: Array.from({ length: 16 }, (_, i) => ({
        id: `h${i}`, role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `turn ${i} ` + 'word '.repeat(1_200), timestamp: 't'
      }))
    })
    responses.push('<summary>\n1. Requests: the whole story so far.\n</summary>', CLOSE)
    const harness = renderChatHook()
    await send(harness, '继续')
    expect(calls).toHaveLength(2)
    expect(calls[0][0].content).toContain('You summarize the earlier part of a conversation')
    expect(calls[0][1].content).toContain('TRANSCRIPT (')
    const turn = calls[1]
    const noteAt = turn.findIndex(m => m.content.includes('<conversation_summary>\n1. Requests: the whole story so far.\n</conversation_summary>'))
    expect(noteAt).toBeGreaterThan(0)
    expect(turn[noteAt + 1].content).toBe('Understood. I will continue from this summary.')
    expect(turn.some(m => m.content.startsWith('turn 0 '))).toBe(false)
    expect(turn.some(m => m.content.startsWith('turn 14 '))).toBe(true)
    expect(finalUserContent(1)).toContain('USER REQUEST:\n继续')
    harness.unmount()
  })
})

describe('useChatLLM — the turn after a Stop', () => {
  it('tells the model the previous turn was stopped, on the final user message', async () => {
    useAppStore.setState({
      messages: [
        { id: 'u0', role: 'user', content: '写第一章', timestamp: 't' },
        { id: 'a0', role: 'assistant', content: '写到一半\n\n⏹️ Stopped.', timestamp: 't', agent: { status: 'stopped', steps: 1, trace: [], touched: [], timeline: [] } }
      ]
    })
    responses.push(CLOSE)
    const harness = renderChatHook()
    await send(harness, '继续')
    expect(finalUserContent(0)).toContain('USER REQUEST:\n继续')
    expect(finalUserContent(0)).toContain('The user stopped your previous turn before it finished')
    harness.unmount()
  })

  it('says nothing when the previous turn finished', async () => {
    useAppStore.setState({
      messages: [
        { id: 'u0', role: 'user', content: '写第一章', timestamp: 't' },
        { id: 'a0', role: 'assistant', content: '写好了。', timestamp: 't' }
      ]
    })
    responses.push(CLOSE)
    const harness = renderChatHook()
    await send(harness, '继续')
    expect(finalUserContent(0)).not.toContain('stopped your previous turn')
    harness.unmount()
  })
})

describe('useChatLLM — normal completion', () => {
  it('applies a <canvas> rewrite to the active document and shows the chat text', async () => {
    responses.push('Done.\n<canvas><h1>New</h1><p>fresh text</p></canvas>')
    const harness = renderChatHook()

    await send(harness, '重写这一章')

    // A write does not end the turn: its result goes back to the model, and
    // the model's reply with no action (the script's default) closes it.
    expect(calls).toHaveLength(2)
    expect(finalUserContent(1)).toContain('RESULT OF YOUR DOCUMENT CHANGES')
    // The update lands as a reviewable diff, not a raw replacement.
    expect(activeContent()).toContain('New')
    expect(activeContent()).toContain('fresh')
    expect(activeContent()).toContain('diff-addition')
    expect(activeContent()).toContain('<del class="diff-deletion"')
    expect(assistantBubble()).toEqual(['Done.'])
    expect(useAppStore.getState().isStreaming).toBe(false)
    harness.unmount()
  })

  it('sends the active document and the user request in the final user message', async () => {
    responses.push('<canvas><p>x</p></canvas>')
    const harness = renderChatHook()

    await send(harness, '继续写')

    expect(finalUserContent(0)).toContain('<p>old text</p>')
    expect(finalUserContent(0)).toContain('USER REQUEST:\n继续写')
    harness.unmount()
  })
})

describe('useChatLLM — cache-first prompt layout', () => {
  // The acceptance criterion from docs/features/cache_first_context.md: two
  // consecutive turns must share every message before the volatile tail. No
  // model is needed to check it — assemble twice and compare the strings.
  const prefixOf = (callIndex: number) =>
    calls[callIndex].slice(0, -1).map(m => `${m.role}:${m.content}`).join('\n---\n')

  beforeEach(() => {
    useAppStore.setState({
      documents: [
        doc('doc-1', 'Chapter 1', '<p>old text</p>'),
        { ...doc('doc-2', 'Chapter 2', '<p>the betrayal</p>'), summary: 'A betrayal.' },
        { ...doc('doc-3', 'Chapter 3', '<p>the return</p>'), summary: 'A return.' }
      ],
      activeDocumentId: 'doc-1'
    })
  })
  // With the agent tools on, chapters reach the ledger only by a pin
  // (docs/features/pinned_context.md); the model reads the rest itself.
  const pin = (...ids: string[]) => useAppStore.setState(st => ({ documents: st.documents.map(d => ids.includes(d.id) ? { ...d, pinned: true } : d) }))
  const unpin = (...ids: string[]) => useAppStore.setState(st => ({ documents: st.documents.map(d => ids.includes(d.id) ? { ...d, pinned: false } : d) }))

  it('keeps every message before the tail byte-identical across turns', async () => {
    responses.push('<canvas><p>a</p></canvas>', CLOSE, '<canvas><p>b</p></canvas>')
    pin('doc-2')
    const harness = renderChatHook()

    await send(harness, '关于 Chapter 2 的第一个问题')
    const firstTail = calls[0].length
    // Each turn takes two steps (write, then close); compare the turns' FIRST
    // requests.
    const second = calls.length
    await send(harness, '第二个完全不同的问题')

    // The second turn appends history; everything the first turn sent before
    // its own tail is still there, unchanged, in the same order.
    expect(second).toBe(2)
    expect(prefixOf(second).startsWith(prefixOf(0))).toBe(true)
    expect(calls[second].length).toBeGreaterThan(firstTail)
    // …and that shared prefix actually carries the chapter, which is the whole
    // point. Without this the assertion above passes trivially on a prefix of
    // nothing but the system prompt.
    expect(prefixOf(0)).toContain('REFERENCED CHAPTERS')
    expect(prefixOf(0)).toContain('the betrayal')
    // The tail is what changed — the request, and nothing before it.
    expect(finalUserContent(second)).toContain('第二个完全不同的问题')
    expect(finalUserContent(second)).not.toContain('the betrayal')
    harness.unmount()
  })

  it('attaches nothing the writer did not pin, even a chapter the request names, and shows no label', async () => {
    responses.push('<canvas><p>a</p></canvas>')
    const harness = renderChatHook()

    await send(harness, '照着 Chapter 2 写下去')

    expect(calls[0].some(m => m.content.includes('REFERENCED CHAPTERS'))).toBe(false)
    expect(calls[0].some(m => m.content.includes('the betrayal'))).toBe(false)
    // The index still lists it, so the model can read it.
    expect(finalUserContent(0)).toContain('Chapter 2')
    expect(useAppStore.getState().messages.some(m => m.content.includes('[Attached Context'))).toBe(false)
    harness.unmount()
  })

  // Tools off is now the only place the keyword scorer runs: that model
  // cannot read a chapter itself (pinned_context.md §2).
  it('with the agent tools off, still attaches a chapter the request names, and labels it', async () => {
    responses.push('<canvas><p>a</p></canvas>\n<doc_status>updated</doc_status>')
    const s = useAppStore.getState()
    useAppStore.setState({ providerConfigs: { ...s.providerConfigs, [s.activeProvider]: { ...s.providerConfigs[s.activeProvider], agentTools: false } } })
    try {
      const harness = renderChatHook()
      await send(harness, '照着 Chapter 2 写下去')
      const ledger = calls[0].find(m => m.content.includes('REFERENCED CHAPTERS'))
      expect(ledger?.content).toContain('the betrayal')
      expect(useAppStore.getState().messages.some(m => m.role === 'assistant' && m.content.includes('[Attached Context: Chapter 2'))).toBe(true)
      harness.unmount()
    } finally {
      useAppStore.setState({ providerConfigs: s.providerConfigs })
    }
  })

  it('puts a pinned chapter ahead of the history, not in the final message', async () => {
    responses.push('<canvas><p>a</p></canvas>')
    pin('doc-2')
    const harness = renderChatHook()

    await send(harness, '照着 Chapter 2 写下去')

    const ledger = calls[0].find(m => m.content.includes('REFERENCED CHAPTERS'))
    expect(ledger).toBeDefined()
    expect(ledger!.content).toContain('the betrayal')
    expect(ledger!.cacheHint).toBe(true)
    // …and the volatile tail carries only the active document and the request.
    expect(finalUserContent(0)).not.toContain('the betrayal')
    expect(finalUserContent(0)).toContain('<p>old text</p>')
    harness.unmount()
  })

  it('appends a newly pinned chapter without disturbing the first one', async () => {
    responses.push('<canvas><p>a</p></canvas>', CLOSE, '<canvas><p>b</p></canvas>')
    pin('doc-2')
    const harness = renderChatHook()

    await send(harness, '先看 Chapter 2')
    // A second chapter joins: it must be APPENDED, never inserted or re-sorted.
    pin('doc-3')
    const second = calls.length
    await send(harness, '再看 Chapter 3')

    const before = calls[0].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content
    const after = calls[second].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content
    expect(after.startsWith(before.replace(/\n$/, ''))).toBe(true)
    expect(after).toContain('the return')
    harness.unmount()
  })

  it('drops an unpinned chapter at the next turn', async () => {
    responses.push('<canvas><p>a</p></canvas>', CLOSE, '<canvas><p>b</p></canvas>')
    pin('doc-2', 'doc-3')
    const harness = renderChatHook()

    await send(harness, '第一轮')
    unpin('doc-3')
    const second = calls.length
    await send(harness, '第二轮')

    const after = calls[second].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content
    expect(after).toContain('the betrayal')
    expect(after).not.toContain('the return')
    harness.unmount()
  })

  // pinned_context.md §2.1: opening the outline to look at it used to drop
  // it from the ledger, and closing it re-added it — two cache misses.
  it('keeps a pinned chapter in place while the writer has it open, and says when its copy is older', async () => {
    responses.push('<canvas><p>a</p></canvas>', CLOSE, '<canvas><p>b</p></canvas>', CLOSE, '<canvas><p>c</p></canvas>')
    pin('doc-2', 'doc-3')
    const harness = renderChatHook()

    await send(harness, '第一轮')
    useAppStore.setState({ activeDocumentId: 'doc-2' })
    const second = calls.length
    await send(harness, '第二轮')
    // Opened: the ledger is unchanged, so the whole prefix is still the first turn's.
    const ledger1 = calls[0].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content
    const ledger2 = calls[second].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content
    expect(ledger2).toBe(ledger1)
    expect(finalUserContent(second)).not.toContain('is older')

    // Edited while open: the copy above stays, and the tail says which text is current.
    useAppStore.getState().updateDocument('doc-2', { content: '<p>the betrayal, revised</p>' })
    const third = calls.length
    await send(harness, '第三轮')
    expect(calls[third].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content).toBe(ledger1)
    expect(finalUserContent(third)).toContain('Its copy under REFERENCED CHAPTERS is older: this is its current text')
    harness.unmount()
  })

  it('budgets pins on their text, not their HTML', async () => {
    responses.push('<canvas><p>a</p></canvas>')
    // Each chapter is ~25k of HTML but ~3k of text: counted as HTML the third would not fit 60k.
    const heavy = (word: string) => `<p>${`<span style="color: rgb(10, 20, 30); font-weight: bold">${word}</span>`.repeat(300)}</p>`
    useAppStore.setState({
      documents: [
        doc('doc-1', 'Chapter 1', '<p>old text</p>'),
        { ...doc('doc-2', 'Cards', heavy('甲甲甲甲甲')), pinned: true },
        { ...doc('doc-3', 'Setting', heavy('乙乙乙乙乙')), pinned: true },
        { ...doc('doc-4', 'Outline', heavy('丙丙丙丙丙')), pinned: true }
      ]
    })
    const harness = renderChatHook()
    await send(harness, '写')
    const ledger = calls[0].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content
    for (const word of ['甲甲甲', '乙乙乙', '丙丙丙']) expect(ledger).toContain(word)
    harness.unmount()
  })
})

describe('useChatLLM — document tools', () => {
  it('applies a tool call to the document, with no tags anywhere', () => {
    // The whole point of the migration: no <canvas>, no <doc_status>, and the
    // document still changes — because the model called a tool instead.
    return (async () => {
      responses.push({
        text: '好的，已经写好了。',
        toolCalls: [{ index: 0, name: 'update_document', argumentsText: '{"html": "<h1>Ch9</h1><p>TOOL_WRITTEN</p>"}' }]
      } as never)
      const harness = renderChatHook()

      await send(harness, '写第九章')

      expect(activeContent()).toContain('TOOL_WRITTEN')
      expect(activeContent()).toContain('diff-addition')
      expect(assistantBubble()).toEqual(['好的，已经写好了。'])
      harness.unmount()
    })()
  })

  it('assembles one call from many argument deltas', () => {
    // Arguments arrive in fragments — 205 of them on a real local stream. The
    // document must end up with the whole value, not the first fragment.
    // (Rendering the PARTIAL value is the editor's job and is covered where an
    // editor exists: utils/toolCallStream and the rejoin harness.)
    return (async () => {
      responses.push({
        text: '',
        toolCalls: [
          { index: 0, name: 'update_document', argumentsText: '{"html": "<p>ASSEMBLED' },
          { index: 0, argumentsText: '_FROM_PIECES</p>"}' }
        ]
      } as never)
      const harness = renderChatHook()

      await send(harness, '写一段')

      expect(activeContent()).toContain('ASSEMBLED_FROM_PIECES')
      harness.unmount()
    })()
  })

  it('hands an unusable tool call back to the model, which then gets it right', async () => {
    // A called-but-unusable tool used to end the turn in silence. The loop
    // feeds the error back (spec D3) and the model corrects itself.
    useAppStore.setState({ documents: [doc('doc-1', 'Chapter 1', '<p>one</p><p>two</p>')], activeDocumentId: 'doc-1' })
    responses.push({
      text: '好的。',
      toolCalls: [{ index: 0, name: 'edit_document', argumentsText: '{"edits": []}' }]
    } as never)
    responses.push({
      text: '改好了。',
      toolCalls: [{ index: 0, name: 'edit_document', argumentsText: '{"edits":[{"search":"<p>two</p>","replace":"<p>TWO</p>"}]}' }]
    } as never)
    const harness = renderChatHook()

    await send(harness, '改一下第二段')

    // Bad call, fixed call, closing reply.
    expect(calls).toHaveLength(3)
    expect(calls[1].at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('was not run') })
    const { stripDiffMarkup } = await import('../../utils/diff')
    expect(stripDiffMarkup(activeContent())).toBe('<p>one</p><p>TWO</p>')
    expect(assistantBubble()[0]).not.toContain('⚠️')
    harness.unmount()
  })

  it('says so when the model never produces a usable call (corrective budget spent)', async () => {
    for (let i = 0; i < 4; i++) {
      responses.push({
        text: '好的。',
        toolCalls: [{ index: 0, name: 'edit_document', argumentsText: '{"edits": []}' }]
      } as never)
    }
    const harness = renderChatHook()

    await send(harness, '改一下第二段')

    expect(calls).toHaveLength(4)
    expect(assistantBubble()[0]).toContain('⚠️')
    expect(assistantBubble()[0]).toContain('could not be used')
    expect(activeContent()).toBe('<p>old text</p>')
    harness.unmount()
  })

  it('does not retry a tool-call turn for a missing doc_status', () => {
    // Calling a tool IS the declaration. Demanding the line as well would
    // retry every successful turn.
    return (async () => {
      responses.push({
        text: '写好了。',
        toolCalls: [{ index: 0, name: 'update_document', argumentsText: '{"html": "<p>x</p>"}' }]
      } as never)
      // The closing reply carries no declaration either.
      responses.push('好了。')
      const harness = renderChatHook()

      await send(harness, '写一段')

      // The write's result, then the close — no corrective step after either.
      expect(calls).toHaveLength(2)
      expect(calls[1].at(-1)?.content).not.toContain('did not follow the output protocol')
      expect(assistantBubble()[0]).not.toContain('⚠️')
      harness.unmount()
    })()
  })
})

describe('useChatLLM — edits against a pending diff', () => {
  // The reported case: the PREVIOUS turn rewrote a paragraph and its diff is
  // still unresolved, so the document holds <del>old</del><ins>new</ins>
  // markup. The model is shown the stripped "accepted" reading and copies its
  // SEARCH from that — a clean needle that can never match the markup-laden
  // haystack. Deleting the rewritten paragraph silently did nothing.
  it('applies a deletion whose target is still wrapped in diff markup', async () => {
    const { diffHtml, stripDiffMarkup } = await import('../../utils/diff')
    // Build the pending state with the real diff machinery, not hand-rolled
    // markup: previous turn rewrote "old dup" into "dup para".
    const pending = diffHtml(
      '<p>intro</p><p>old dup</p><p>tail</p>',
      '<p>intro</p><p>dup para</p><p>tail</p>'
    )
    expect(pending).toContain('diff-addition') // precondition: diff is live
    useAppStore.setState({
      documents: [doc('doc-1', 'Chapter 1', pending)],
      activeDocumentId: 'doc-1'
    })
    responses.push(
      '删掉重复段。\n<edit>\n<<<<<<< SEARCH\n<p>dup para</p>\n=======\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>'
    )
    const harness = renderChatHook()

    await send(harness, '删掉重复的那段')

    // The pending diff folds in as accepted (what the model was told the
    // document says) and the deletion lands as a fresh reviewable diff.
    const content = activeContent()
    expect(stripDiffMarkup(content)).toBe('<p>intro</p><p>tail</p>')
    expect(content).toContain('diff-deletion')
    harness.unmount()
  })

  it('keeps the previous turn\'s change under review: the rewrite is diffed from the last CONFIRMED text', async () => {
    // User-reported 2026-10-06: asking for another change while the previous
    // one was still under review silently accepted the previous one. The
    // model still writes from the accepted reading (beta), but the review is
    // drawn from what the user last confirmed (alpha), so both changes stay
    // pending and reject-all returns alpha.
    const { diffHtml, stripDiffMarkup } = await import('../../utils/diff')
    const { resolveDiffMarkupInHtml } = await import('../../utils/diffResolution')
    const pending = diffHtml('<p>alpha</p>', '<p>beta</p>')
    useAppStore.setState({
      documents: [doc('doc-1', 'Chapter 1', pending)],
      activeDocumentId: 'doc-1'
    })
    responses.push('<canvas><p>gamma</p></canvas>\n<doc_status>updated</doc_status>')
    const harness = renderChatHook()

    await send(harness, '重写')

    const content = activeContent()
    expect(stripDiffMarkup(content)).toBe('<p>gamma</p>')
    expect(resolveDiffMarkupInHtml(content, 'reject')).toBe('<p>alpha</p>')
    // One diff, not a diff nested inside the pending one.
    expect(content).not.toContain('beta')
    harness.unmount()
  })
})

describe('useChatLLM — no-action retry', () => {
  it('retries once with a corrective instruction and applies the recovered update', async () => {
    responses.push('已按大纲接上第二章，直接落笔。')            // tag-free: writes nothing
    responses.push('好了。\n<canvas><h1>Ch3</h1><p>正文</p></canvas>\n<doc_status>updated</doc_status>')
    const harness = renderChatHook()

    await send(harness, '继续写第三章')

    // Failed reply, corrected reply, closing reply.
    expect(calls).toHaveLength(3)
    // The failed reply is quoted back, then corrected.
    const retryMessages = calls[1]
    expect(retryMessages[retryMessages.length - 2]).toMatchObject({
      role: 'assistant',
      content: '已按大纲接上第二章，直接落笔。'
    })
    // The corrective turn spells out BOTH acceptable shapes, so a model that
    // genuinely has nothing to change can comply without inventing an edit.
    expect(finalUserContent(1)).toContain('did not follow the output protocol')
    expect(finalUserContent(1)).toContain('<doc_status>unchanged</doc_status>')
    // The recovery replaces the same bubble — no second assistant message.
    expect(assistantBubble()).toEqual(['好了。'])
    expect(activeContent()).toContain('Ch3')
    harness.unmount()
  })

  it('recovers on a later retry, not just the first', async () => {
    responses.push('已写好第三章。')          // attempt 1: nothing
    responses.push('第三章已经写完了。')       // retry 1: nothing
    responses.push('好了。\n<canvas><p>RECOVERED_LATE</p></canvas>\n<doc_status>updated</doc_status>')  // retry 2: content
    const harness = renderChatHook()

    await send(harness, '继续写第三章')

    expect(calls).toHaveLength(4)
    expect(assistantBubble()).toEqual(['好了。'])
    expect(activeContent()).toContain('RECOVERED_LATE')
    harness.unmount()
  })

  it('stops after the bounded retries and warns instead of reporting success', async () => {
    for (let i = 0; i < 6; i++) responses.push(`已写好第三章。(${i})`)
    const harness = renderChatHook()

    await send(harness, '继续写第三章')

    expect(calls).toHaveLength(4) // first attempt + MAX_NO_ACTION_RETRIES (3)
    expect(assistantBubble()).toHaveLength(1)
    expect(assistantBubble()[0]).toContain('⚠️ The model never produced a valid document update or a clear "no change" declaration')
    expect(activeContent()).toBe('<p>old text</p>') // untouched
    expect(useAppStore.getState().isStreaming).toBe(false)
    harness.unmount()
  })

  it('does not retry a clarifying question', async () => {
    responses.push('你想让第三章从哪里开始写？\n<doc_status>unchanged</doc_status>')
    const harness = renderChatHook()

    await send(harness, '写啊')

    expect(calls).toHaveLength(1)
    expect(assistantBubble()).toEqual(['你想让第三章从哪里开始写？'])
    expect(activeContent()).toBe('<p>old text</p>')
    harness.unmount()
  })

  it('retries when the model declares an update it did not emit', async () => {
    // Neutral prose: only the model's own declaration exposes the broken turn.
    responses.push('嗯。\n<doc_status>updated</doc_status>')
    responses.push('好了。\n<canvas><p>DECLARED_FIX</p></canvas>\n<doc_status>updated</doc_status>')
    const harness = renderChatHook()

    await send(harness, '随便看看')

    expect(calls).toHaveLength(3)
    expect(activeContent()).toContain('DECLARED_FIX')
    // The declaration is protocol — the user never sees it.
    expect(assistantBubble()).toEqual(['好了。'])
    harness.unmount()
  })

  it('trusts a declared non-edit over claim-shaped prose', async () => {
    responses.push('你已经把这段改好了，读起来顺多了。\n<doc_status>unchanged</doc_status>')
    const harness = renderChatHook()

    await send(harness, '再改改这段')

    expect(calls).toHaveLength(1)
    expect(assistantBubble()).toEqual(['你已经把这段改好了，读起来顺多了。'])
    expect(activeContent()).toBe('<p>old text</p>')
    harness.unmount()
  })

  it('retries broken edit markup even when the request read like a question', async () => {
    // The model's own output is the signal: it tried to edit and got the shape
    // wrong, so the turn is broken no matter how the request was phrased.
    responses.push('<edit>\n<<<<<<< SEARCH\n<p>old text</p>\n(mangled)')
    responses.push('好了。\n<canvas><p>FIXED_MARKUP</p></canvas>')
    const harness = renderChatHook()

    await send(harness, '你觉得这段怎么样')

    expect(calls).toHaveLength(3)
    expect(activeContent()).toContain('FIXED_MARKUP')
    harness.unmount()
  })

  it('lets the model decline to edit when it says so in the protocol', async () => {
    // Deciding whether the document needs changing is the model's call — but
    // it has to SAY so. A declared non-edit ships as chat even though the user
    // said "改"; the same reply without the declaration is a failed turn.
    responses.push('流式测试正常，本次无需改文档。\n<doc_status>unchanged</doc_status>')
    const harness = renderChatHook()

    await send(harness, '改一下这段')

    expect(calls).toHaveLength(1)
    expect(assistantBubble()).toEqual(['流式测试正常，本次无需改文档。'])
    expect(activeContent()).toBe('<p>old text</p>')
    harness.unmount()
  })

  it('does not retry a substantive chat answer that made no document change', async () => {
    const answer = '关于后续走向，我建议把冲突集中在三条线上，'.repeat(12) + '\n<doc_status>unchanged</doc_status>'
    responses.push(answer)
    const harness = renderChatHook()

    await send(harness, '你觉得后面该怎么写')

    expect(calls).toHaveLength(1)
    expect(activeContent()).toBe('<p>old text</p>')
    harness.unmount()
  })
})


describe('useChatLLM — live <canvas> streaming into the editor', () => {
  // The stream arrives in pieces; the scripted mock delivers them as chunks so
  // the throttled preview can run more than once.
  const streamCanvasInChunks = (chunks: string[]) => {
    responses.push({ chunks })
  }

  it('renders partial document HTML into the editor while streaming', async () => {
    const { editor, writes, meta } = stubEditor()
    streamCanvasInChunks([
      '写好了。\n<canvas><h1>Ch3</h1>',
      '<p>第一段</p><h',              // cut mid-tag: must never reach the editor
      '2>小节</h2><p>第二段还没写完',
      '</p></canvas>'
    ])
    const harness = renderChatHook(editor)

    await send(harness, '继续写第三章')

    // Something was shown before the stream finished…
    expect(writes.length).toBeGreaterThan(1)
    expect(writes.some(w => w.includes('Ch3') && !w.includes('第二段'))).toBe(true)
    // …never with a half-streamed tag…
    expect(writes.every(w => !/<[^>]*$/.test(w))).toBe(true)
    // …and never added to the undo stack.
    expect(meta.every(v => v === false)).toBe(true)
    // The final editor state is the diffed document, not the raw stream.
    expect(editor.getHTML()).toContain('diff-addition')
    harness.unmount()
  })

  it('rolls the editor back when the response turns out to be truncated', async () => {
    const { editor } = stubEditor()
    // Opening tag, content, no closing tag: validateCanvasReplacement refuses it.
    streamCanvasInChunks(['<canvas><h1>Ch3</h1>', '<p>cut off mid-sentence'])
    const harness = renderChatHook(editor)

    await send(harness, '继续写第三章')

    expect(assistantBubble()[0]).toContain('⚠️ The response was cut off')
    expect(activeContent()).toBe('<p>old text</p>')
    // The half-streamed draft must not survive on screen.
    expect(editor.getHTML()).toBe('<p>old text</p>')
    harness.unmount()
  })

  it('rolls the editor back when the stream errors', async () => {
    const { editor } = stubEditor()
    responses.push({ chunks: ['<canvas><h1>Ch3</h1><p>partial'], error: 'network died' })
    const harness = renderChatHook(editor)

    await send(harness, '继续写第三章')

    expect(editor.getHTML()).toBe('<p>old text</p>')
    harness.unmount()
  })
})

describe('useChatLLM — stopping mid-stream', () => {
  // Both transports report a stop as an error that names the abort
  // (readSSEDataLines throws 'Stream aborted by user'; a cancelled fetch
  // rejects with an AbortError). The script does the same.
  const streamThenStop = (chunks: string[]) => {
    responses.push({ chunks, error: 'Stream aborted by user' })
  }

  it('keeps the half-streamed draft on screen AND in the store', async () => {
    const { editor } = stubEditor()
    streamThenStop(['<canvas><h1>Ch3</h1>', '<p>第一段</p><p>第二段'])
    const harness = renderChatHook(editor)

    await send(harness, '继续写第三章')

    // Not rolled back: the draft stays on screen…
    expect(editor.getHTML()).toContain('第一段')
    // …and the store holds the very same HTML, so a reload shows the screen.
    expect(activeContent()).toBe(editor.getHTML())
    expect(useAppStore.getState().isStreaming).toBe(false)
    expect(assistantBubble()[0]).toContain('⏹️')
    expect(assistantBubble()[0]).toContain('Undo')
    harness.unmount()
  })

  it('commits the draft as ONE undo step that returns to the pre-stream document', async () => {
    const { editor, writes, recorded } = stubEditor()
    streamThenStop(['<canvas><h1>Ch3</h1>', '<p>第一段</p><p>第二段'])
    const harness = renderChatHook(editor)

    await send(harness, '继续写第三章')

    // The previews never entered history. The last two writes rebuild the
    // transition: the pre-stream document outside history, then the draft
    // as the only recorded write — so Undo lands on the pre-stream document.
    const draft = editor.getHTML()
    expect(writes.filter((_, i) => recorded[i])).toEqual([draft])
    expect(writes.slice(-2)).toEqual(['<p>old text</p>', draft])
    expect(recorded.slice(-2)).toEqual([false, true])
    harness.unmount()
  })

  it('leaves the document alone when the stop came before any draft', async () => {
    const { editor, writes } = stubEditor()
    streamThenStop(['Let me think about the structure first'])
    const harness = renderChatHook(editor)

    await send(harness, '继续写第三章')

    expect(writes).toEqual([])
    expect(editor.getHTML()).toBe('<p>old text</p>')
    expect(activeContent()).toBe('<p>old text</p>')
    // The bubble keeps what was said and reports the stop — not "Thinking...".
    expect(assistantBubble()[0]).toBe('Let me think about the structure first\n\n⏹️ Stopped.')
    harness.unmount()
  })
})

describe('useChatLLM — the agentic loop (phase 1)', () => {
  let savedProvider: string
  beforeEach(() => { savedProvider = useAppStore.getState().activeProvider })
  afterEach(() => { useAppStore.setState({ activeProvider: savedProvider as never }) })

  it('does not retry a plain answer on the tool protocol, which never taught <doc_status>', async () => {
    // ollama resolves to the tool protocol under 'auto'. Before the loop a
    // question answered in prose was judged "undeclared" and retried three
    // times with an instruction about tags this model was never shown.
    useAppStore.setState({ activeProvider: 'ollama' })
    responses.push('大约一千二百字。')
    const harness = renderChatHook()

    await send(harness, '这一章多少字？')

    expect(calls).toHaveLength(1)
    expect(assistantBubble()).toEqual(['大约一千二百字。'])
    harness.unmount()
  })

  it('applies every edit_document call in a reply, not only the first', async () => {
    useAppStore.setState({
      documents: [doc('doc-1', 'Chapter 1', '<p>one</p><p>two</p>')],
      activeDocumentId: 'doc-1'
    })
    responses.push({
      text: '两处都改了。',
      toolCalls: [
        { index: 0, name: 'edit_document', argumentsText: '{"edits":[{"search":"<p>one</p>","replace":"<p>ONE</p>"}]}' },
        { index: 1, name: 'edit_document', argumentsText: '{"edits":[{"search":"<p>two</p>","replace":"<p>TWO</p>"}]}' }
      ]
    } as never)
    const harness = renderChatHook()

    await send(harness, '两段都大写')

    const { stripDiffMarkup } = await import('../../utils/diff')
    expect(stripDiffMarkup(activeContent())).toBe('<p>ONE</p><p>TWO</p>')
    expect(assistantBubble()).toEqual(['两处都改了。'])
    harness.unmount()
  })
})
