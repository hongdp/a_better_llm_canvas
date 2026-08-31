/**
 * Flow tests for the chat orchestration hook.
 *
 * `startLLMStreaming` has three re-entrant paths that all drive the SAME
 * assistant bubble: the no-action retry,
 * and normal completion. Each re-issues the request through a ref, so a
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
    const scripted = responses.shift()
    if (scripted === undefined) {
      callbacks.onError(new Error('scripted responses exhausted'))
      return
    }
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
  let html = '<p>old text</p>'
  const chain = {
    setMeta: (_k: string, v: unknown) => { meta.push(v); return chain },
    setContent: (c: string) => { writes.push(c); html = c; return chain },
    run: () => true
  }
  return {
    writes,
    meta,
    editor: {
      chain: () => chain,
      getHTML: () => html,
      commands: { setContent: (c: string) => { writes.push(c); html = c } },
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
    wholeBookMode: 'off',
    pinnedReferenceIds: [],
    blockedReferenceIds: [],
    debugMode: false,
    activeSystemPromptId: 'prompt-none',
    customSystemPrompts: [{ id: 'prompt-none', name: 'None', content: '' }]
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useChatLLM — normal completion', () => {
  it('applies a <canvas> rewrite to the active document and shows the chat text', async () => {
    responses.push('Done.\n<canvas><h1>New</h1><p>fresh text</p></canvas>')
    const harness = renderChatHook()

    await send(harness, '重写这一章')

    expect(calls).toHaveLength(1)
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
      activeDocumentId: 'doc-1',
      pinnedReferenceIds: ['doc-2']
    })
  })

  it('keeps every message before the tail byte-identical across turns', async () => {
    responses.push('<canvas><p>a</p></canvas>', '<canvas><p>b</p></canvas>')
    const harness = renderChatHook()

    await send(harness, '第一个问题')
    const firstTail = calls[0].length
    await send(harness, '第二个完全不同的问题')

    // The second turn appends history; everything the first turn sent before
    // its own tail is still there, unchanged, in the same order.
    expect(calls).toHaveLength(2)
    expect(prefixOf(1).startsWith(prefixOf(0))).toBe(true)
    expect(calls[1].length).toBeGreaterThan(firstTail)
    // …and that shared prefix actually carries the chapter, which is the whole
    // point. Without this the assertion above passes trivially on a prefix of
    // nothing but the system prompt.
    expect(prefixOf(0)).toContain('REFERENCED CHAPTERS')
    expect(prefixOf(0)).toContain('the betrayal')
    // The tail is what changed — the request, and nothing before it.
    expect(finalUserContent(1)).toContain('第二个完全不同的问题')
    expect(finalUserContent(1)).not.toContain('the betrayal')
    harness.unmount()
  })

  it('puts the pinned chapter ahead of the history, not in the final message', async () => {
    responses.push('<canvas><p>a</p></canvas>')
    const harness = renderChatHook()

    await send(harness, '写下去')

    const ledger = calls[0].find(m => m.content.includes('REFERENCED CHAPTERS'))
    expect(ledger).toBeDefined()
    expect(ledger!.content).toContain('the betrayal')
    expect(ledger!.cacheHint).toBe(true)
    // …and the volatile tail carries only the active document and the request.
    expect(finalUserContent(0)).not.toContain('the betrayal')
    expect(finalUserContent(0)).toContain('<p>old text</p>')
    harness.unmount()
  })

  it('appends a newly attached chapter without disturbing the first one', async () => {
    responses.push('<canvas><p>a</p></canvas>', '<canvas><p>b</p></canvas>')
    const harness = renderChatHook()

    await send(harness, '第一轮')
    // Pin a second chapter: it must be APPENDED, never inserted or re-sorted.
    useAppStore.setState({ pinnedReferenceIds: ['doc-2', 'doc-3'] })
    await send(harness, '第二轮')

    const before = calls[0].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content
    const after = calls[1].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content
    expect(after.startsWith(before.replace(/\n$/, ''))).toBe(true)
    expect(after).toContain('the return')
    harness.unmount()
  })

  it('drops the chapter the writer switches to, keeping the rest cached', async () => {
    responses.push('<canvas><p>a</p></canvas>', '<canvas><p>b</p></canvas>')
    const harness = renderChatHook()

    useAppStore.setState({ pinnedReferenceIds: ['doc-2', 'doc-3'] })
    await send(harness, '第一轮')
    // Now edit chapter 2 — it must leave the ledger rather than sit there as a
    // stale duplicate of the document in the tail.
    useAppStore.setState({ activeDocumentId: 'doc-2', pinnedReferenceIds: ['doc-3'] })
    await send(harness, '第二轮')

    const after = calls[1].find(m => m.content.includes('REFERENCED CHAPTERS'))!.content
    expect(after).not.toContain('the betrayal')
    expect(after).toContain('the return')
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

  it('says so when a tool call yields nothing applicable', () => {
    // A called-but-unusable tool used to end the turn in silence: no change,
    // no explanation, indistinguishable from the model deciding not to edit.
    return (async () => {
      responses.push({
        text: '好的。',
        toolCalls: [{ index: 0, name: 'edit_document', argumentsText: '{"edits": []}' }]
      } as never)
      const harness = renderChatHook()

      await send(harness, '改一下第二段')

      expect(assistantBubble()[0]).toContain('⚠️')
      expect(assistantBubble()[0]).toContain('could not be used')
      expect(activeContent()).toBe('<p>old text</p>')
      harness.unmount()
    })()
  })

  it('does not retry a tool-call turn for a missing doc_status', () => {
    // Calling a tool IS the declaration. Demanding the line as well would
    // retry every successful turn.
    return (async () => {
      responses.push({
        text: '写好了。',
        toolCalls: [{ index: 0, name: 'update_document', argumentsText: '{"html": "<p>x</p>"}' }]
      } as never)
      const harness = renderChatHook()

      await send(harness, '写一段')

      expect(calls).toHaveLength(1)
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

  it('bases a full <canvas> rewrite on the accepted reading, not the markup', async () => {
    const { diffHtml, stripDiffMarkup } = await import('../../utils/diff')
    const pending = diffHtml('<p>alpha</p>', '<p>beta</p>')
    useAppStore.setState({
      documents: [doc('doc-1', 'Chapter 1', pending)],
      activeDocumentId: 'doc-1'
    })
    responses.push('<canvas><p>gamma</p></canvas>\n<doc_status>updated</doc_status>')
    const harness = renderChatHook()

    await send(harness, '重写')

    // A diff of clean-vs-markup would nest <del> inside <del>; the accepted
    // reading yields exactly one proposal: beta -> gamma.
    const content = activeContent()
    expect(stripDiffMarkup(content)).toBe('<p>gamma</p>')
    expect(content).not.toContain('alpha') // the rejected-side text is gone
    harness.unmount()
  })
})

describe('useChatLLM — no-action retry', () => {
  it('retries once with a corrective instruction and applies the recovered update', async () => {
    responses.push('已按大纲接上第二章，直接落笔。')            // tag-free: writes nothing
    responses.push('好了。\n<canvas><h1>Ch3</h1><p>正文</p></canvas>\n<doc_status>updated</doc_status>')
    const harness = renderChatHook()

    await send(harness, '继续写第三章')

    expect(calls).toHaveLength(2)
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

    expect(calls).toHaveLength(3)
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

    expect(calls).toHaveLength(2)
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

    expect(calls).toHaveLength(2)
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
