/**
 * Flow tests for the agentic loop through the real hook (phase 2): reading,
 * writing other chapters, creating chapters, the step limit, and what each
 * protocol offers. Same harness shape as useChatLLM.test.ts: a scripted
 * `streamLLM`, a stub editor, assertions on the store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LLMMessage } from '../../types/llm'

type ToolDelta = { index: number; id?: string; name?: string; argumentsText: string }
type Scripted = string | {
  text: string
  /** Deliver `text` in these pieces instead of one chunk (they must join to `text`). */
  chunks?: string[]
  toolCalls?: ToolDelta[]
  /** grok's output items (xAI Responses API), delivered before the step ends. */
  responseItems?: unknown[]
  /** Runs after the text streamed, before the step ends (the user acting mid-turn). */
  between?: () => void
  /** End the step with this error instead of completing it. */
  error?: Error
}
const responses: Scripted[] = []
const calls: LLMMessage[][] = []
const configs: Array<{ tools?: Array<{ function: { name: string } }>; toolChoice?: string; model?: string; reasoningEffort?: string; conversationId?: string }> = []

vi.mock('../../services/llm', () => ({
  streamLLM: async (
    messages: LLMMessage[],
    config: { tools?: Array<{ function: { name: string } }>; toolChoice?: string; model?: string; reasoningEffort?: string; conversationId?: string },
    callbacks: {
      onChunk: (c: string) => void
      onDone: (t: string, u?: { promptTokens: number; completionTokens: number }) => void
      onError: (e: Error) => void
      onToolCallDelta?: (d: ToolDelta) => void
      onResponseItem?: (item: unknown) => void
    }
  ) => {
    calls.push(messages)
    configs.push({ tools: config.tools, toolChoice: config.toolChoice, model: config.model, reasoningEffort: config.reasoningEffort, conversationId: config.conversationId })
    // Past the script, the model closes the turn with no action.
    const scripted = responses.shift() ?? '<doc_status>unchanged</doc_status>'
    const r = typeof scripted === 'string' ? { text: scripted } : scripted
    for (const chunk of ('chunks' in r && r.chunks) ? r.chunks : r.text ? [r.text] : []) callbacks.onChunk(chunk)
    for (const d of r.toolCalls ?? []) {
      callbacks.onToolCallDelta?.(d)
      vi.setSystemTime(Date.now() + 300)
    }
    for (const item of ('responseItems' in r && r.responseItems) || []) callbacks.onResponseItem?.(item)
    if ('between' in r) r.between?.()
    if ('error' in r && r.error) {
      callbacks.onError(r.error)
      return
    }
    callbacks.onDone(r.text, { promptTokens: 10, completionTokens: 20 })
  }
}))
vi.mock('../../services/chapterSummaries', () => ({ enqueueStaleSummaryRefreshes: vi.fn() }))

import { useChatLLM } from '../useChatLLM'
import { useAppStore, isEditLocked } from '../../store/useAppStore'
import { stripDiffMarkup } from '../../utils/diff'

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

/** Records every editor write, so a test can prove another chapter's text never painted it. */
function stubEditor(html: string) {
  const writes: string[] = []
  const chain = {
    setMeta: () => chain,
    setContent: (c: string) => { writes.push(c); html = c; return chain },
    run: () => true
  }
  return {
    writes,
    editor: {
      chain: () => chain,
      getHTML: () => html,
      commands: { setContent: (c: string) => { writes.push(c); html = c } },
      state: { selection: { from: 0, to: 0 } }
    }
  }
}

/**
 * A reply that streams like a real one: the chunk that opens a new chapter
 * creates and opens it, and the next ones paint it (documentWrites,
 * previewRewrite). Split just inside the canvas's first paragraph.
 */
const streamed = (text: string, extra: Omit<Scripted, 'text' | 'chunks'> = {}): Scripted => {
  const at = text.indexOf('<p>', text.indexOf('<canvas')) + 4
  return { text, chunks: [text.slice(0, at), text.slice(at)], ...extra }
}

const doc = (id: string, title: string, content: string, summary?: string) => ({
  id, title, content, summary, contentLoaded: true,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
})
const content = (id: string) => useAppStore.getState().documents.find(d => d.id === id)?.content ?? ''
const bubble = () => useAppStore.getState().messages.filter(m => m.role === 'assistant').at(-1)
const offered = (i: number) => (configs[i].tools ?? []).map(t => t.function.name)

const send = async (h: Harness, prompt: string) => {
  await act(async () => { await h.current.handleSendMessage(undefined, prompt) })
  // Async tools (reads load content first) settle over a few microtasks.
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

const OUTLINE = '<p>大纲：第一章，主角离开村子；第二章，进城。</p>'

let savedProvider: string
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] })
  responses.length = 0
  calls.length = 0
  configs.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  savedProvider = useAppStore.getState().activeProvider
  useAppStore.setState({
    documents: [
      doc('doc-1', '序章', '<p>序章正文。</p>'),
      // A chapter between them: the outline must not ride in on adjacency to
      // the active chapter, or no test here would show the model reading it.
      doc('doc-x', '人物表', '<p>主角：阿青。</p>', '主要人物的名字和关系。'),
      // Titled so the prompt's "大纲" never matches it: only the model can find it.
      doc('doc-2', '故事线', OUTLINE, '全书分章计划：每一章发生什么。')
    ],
    activeDocumentId: 'doc-1',
    activeProvider: 'grok',
    messages: [], versions: [], isStreaming: false, user: null, activeBookId: 'book-test', debugMode: false,
    activeSystemPromptId: 'prompt-none', customSystemPrompts: [{ id: 'prompt-none', name: 'None', content: '' }]
  })
})
afterEach(() => {
  useAppStore.setState({ activeProvider: savedProvider as never })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Pin chapters by title: with the agent tools on, only pinned chapters ride ahead of the history (pinned_context.md). */
const pinTitles = (...titles: string[]) => useAppStore.setState(st => ({ documents: st.documents.map(d => titles.includes(d.title) ? { ...d, pinned: true } : d) }))

describe('what a step offers', () => {
  it('offers grok (markup) the read/navigate tools, update_document and edit_paragraphs natively; other writes stay tags', async () => {
    responses.push('好的。\n<doc_status>unchanged</doc_status>')
    const h = renderChatHook()
    await send(h, '你好')

    expect(offered(0)).toEqual(['update_document', 'edit_paragraphs', 'read', 'grep', 'list', 'open_chapter', 'delete_chapter', 'rename_chapter', 'polish_chapter', 'plan', 'ask_user'])
    // …and the system prompt teaches the chapter attribute.
    expect(calls[0][0].content).toContain('<canvas chapter="3">')
    h.unmount()
  })

  it('offers everything natively on the tool protocol', async () => {
    useAppStore.setState({ activeProvider: 'ollama' })
    responses.push('好的。')
    const h = renderChatHook()
    await send(h, '你好')

    expect(offered(0)).toEqual(['update_document', 'edit_document', 'edit_paragraphs', 'read', 'grep', 'list', 'open_chapter', 'delete_chapter', 'rename_chapter', 'polish_chapter', 'plan', 'ask_user'])
    h.unmount()
  })

  it('offers no agent tools when the provider turns them off, and keeps the old prompt', async () => {
    const s = useAppStore.getState()
    useAppStore.setState({ providerConfigs: { ...s.providerConfigs, grok: { ...s.providerConfigs.grok, agentTools: false } } })
    responses.push('好的。\n<doc_status>unchanged</doc_status>')
    const h = renderChatHook()
    await send(h, '你好')

    expect(configs[0].tools).toBeUndefined()
    expect(calls[0][0].content).not.toContain('WORKING ACROSS THE BOOK')
    useAppStore.setState({ providerConfigs: s.providerConfigs })
    h.unmount()
  })
})

describe('finding and reading a chapter (D6)', () => {
  it('finds the outline from the index, reads it, and writes the active chapter from it', async () => {
    responses.push({ text: '先看大纲。', toolCalls: [{ index: 0, id: 'r1', name: 'read_chapter', argumentsText: '{"chapters":[3]}' }] })
    responses.push('写好了。\n<canvas><p>主角离开了村子。</p></canvas>\n<doc_status>updated</doc_status>')
    const h = renderChatHook()
    await send(h, '根据小说大纲写序章')

    // The index the model chose from: the outline is listed by number and
    // title, though nothing called it 大纲 (no summaries since 2026-10-11).
    expect(calls[0].at(-1)?.content).toContain('3. "故事线"')
    expect(calls[0].at(-1)?.content).not.toContain('全书分章计划')
    // Step 2 carries the read result under the call's id.
    expect(calls[1].at(-1)).toMatchObject({ role: 'tool', toolCallId: 'r1', content: expect.stringContaining('主角离开村子') })
    expect(stripDiffMarkup(content('doc-1'))).toBe('<p>主角离开了村子。</p>')
    // The bubble: both steps' chat, and the turn's record.
    expect(bubble()?.content).toContain('先看大纲。')
    expect(bubble()?.content).toContain('写好了。')
    // Read, write, then the reply with no action that closes the turn.
    expect(bubble()?.agent).toMatchObject({ status: 'done', steps: 3, touched: [{ documentId: 'doc-1', kind: 'rewrite' }] })
    expect(bubble()?.agent?.trace[0]).toContain('#3 "故事线"')
    // The bubble shows each call where it happened: after the text of its step.
    expect(bubble()?.agent?.timeline).toEqual([
      { type: 'text', text: '先看大纲。' },
      { type: 'tool', line: expect.stringContaining('📖 read #3 "故事线"'), ok: true },
      { type: 'text', text: '写好了。' },
      { type: 'tool', line: '✏️ rewrote #1 "序章" (8 chars)', ok: true }
    ])
    expect(bubble()?.agent?.live).toBeUndefined()
    h.unmount()
  })

  it('replays what the turn read into the next turn as it was sent, and adds nothing to the ledger (cache_continuity.md)', async () => {
    responses.push({ text: '', toolCalls: [{ index: 0, id: 'r1', name: 'read_chapter', argumentsText: '{"chapters":[3]}' }] })
    responses.push('大纲讲了两章。\n<doc_status>unchanged</doc_status>')
    responses.push('好。\n<doc_status>unchanged</doc_status>')
    const h = renderChatHook()
    await send(h, '大纲讲了什么？')
    await send(h, '继续')

    const turn2 = calls[2]
    // The previous turn as it was sent: its call and its result, not a trace line.
    expect(turn2.slice(0, calls[1].length)).toEqual(calls[1])
    expect(turn2.some(m => m.role === 'tool' && m.toolCallId === 'r1')).toBe(true)
    expect(turn2.some(m => m.content.includes('[Tools used in this turn:'))).toBe(false)
    // A read does not join the ledger: only pins do (pinned_context.md).
    expect(turn2.some(m => m.content.includes('REFERENCED CHAPTERS'))).toBe(false)
    expect(turn2.at(-1)?.content).toContain('3. "故事线" [read earlier, not in context]')
    h.unmount()
  })
})

describe('a chapter the user revised between turns (D8)', () => {
  it('is re-sent in full AND flagged as changed, so the model plans from the new version', async () => {
    // User-reported: the outline was revised before "write chapter 6"; the
    // model had the new text (the ledger re-sends an edited chapter) but
    // nothing told it the text was new, and it did not re-read or re-plan.
    responses.push({ text: '', toolCalls: [{ index: 0, id: 'r1', name: 'read_chapter', argumentsText: '{"chapters":[3]}' }] })
    responses.push('读完了。\n<doc_status>unchanged</doc_status>')
    responses.push('好的。\n<doc_status>unchanged</doc_status>')
    responses.push('好的。\n<doc_status>unchanged</doc_status>')
    pinTitles('故事线')
    const h = renderChatHook()
    await send(h, '看看大纲')
    await send(h, '记住它')

    const revised = '<p>大纲（修订）：第一章，阿青被迫离开村子。</p>'
    useAppStore.getState().updateDocument('doc-2', { content: revised })
    await send(h, '写第一章')

    // The ledger is frozen between summaries: the new text goes in the turn's tail (cache_continuity.md §3.3).
    const turn3 = calls[3]
    expect(turn3.some(m => m.content.includes('REFERENCED CHAPTERS') && m.content.includes('阿青被迫离开村子'))).toBe(false)
    expect(turn3.at(-1)?.content).toContain('PINNED CHAPTERS — changed or pinned since the copy you have')
    expect(turn3.at(-1)?.content).toContain('阿青被迫离开村子')
    expect(turn3.at(-1)?.content).toContain('3. "故事线" [in context — CHANGED since you last saw it')
    h.unmount()
  })
})

describe('the ledger when a chapter in it is edited (frozen, cache_continuity.md §3.3)', () => {
  it('keeps every byte and sends the new version in the turn\'s tail', async () => {
    const body = (tag: string) => `<p>${tag}${'。'.repeat(400)}</p>`
    useAppStore.setState({
      documents: [
        doc('doc-1', '序章', '<p>序章正文。</p>'),
        doc('doc-x', '人物表', body('人物')),
        doc('doc-2', '故事线', body('大纲v1')),
        doc('doc-3', '世界观', body('世界'))
      ]
    })
    responses.push('好。\n<doc_status>unchanged</doc_status>', '好。\n<doc_status>unchanged</doc_status>')
    pinTitles('故事线', '世界观')
    const h = renderChatHook()
    await send(h, '看看故事线和世界观')
    const ledger1 = calls[0].find(m => m.content.startsWith('REFERENCED CHAPTERS'))?.content ?? ''
    // The first entry is the one whose edit used to re-send everything after it.
    const first = /--- DOCUMENT: (.+?) ---/.exec(ledger1)?.[1]
    const firstId = useAppStore.getState().documents.find(d => d.title === first)?.id as string
    expect(ledger1.indexOf(`DOCUMENT: ${first}`)).toBeLessThan(ledger1.lastIndexOf('--- DOCUMENT:'))

    useAppStore.getState().updateDocument(firstId, { content: body('改过了') })
    await send(h, '再看看')

    const ledger2 = calls[1].find(m => m.content.startsWith('REFERENCED CHAPTERS'))?.content ?? ''
    expect(ledger2).toBe(ledger1)
    expect(calls[1].at(-1)?.content).toMatch(new RegExp(`#\\d+ ${first} \\(UPDATED — this version replaces the earlier copy`))
    expect(calls[1].at(-1)?.content).toContain('改过了')
    // …and the index says so too (D8).
    expect(calls[1].at(-1)?.content).toContain(`"${first}" [in context — CHANGED`)
    h.unmount()
  })

  it('renders a chapter with a pending review diff as it reads accepted, not as old+new run together', async () => {
    const { diffHtml } = await import('../../utils/diff')
    useAppStore.setState({
      documents: [
        doc('doc-1', '序章', '<p>序章正文。</p>'),
        doc('doc-x', '人物表', diffHtml('<p>主角叫阿青。</p>', '<p>主角叫阿红。</p>'))
      ]
    })
    pinTitles('人物表')
    responses.push('好。\n<doc_status>unchanged</doc_status>')
    const h = renderChatHook()
    await send(h, '看看')

    const ledger = calls[0].find(m => m.content.startsWith('REFERENCED CHAPTERS'))?.content ?? ''
    expect(ledger).toContain('主角叫阿红')
    expect(ledger).not.toContain('阿青')
    h.unmount()
  })
})

describe('a change still under review (user-reported 2026-10-06)', () => {
  const ORIGINAL = '<p>阿青推开门，屋里很暗。</p><p>她站在窗边，没有回头。</p>'
  const P1_NEW = '<p>阿青轻轻推开门，屋里一片昏暗。</p>'
  const P2_NEW = '<p>她背对着门站在窗边，始终没有回头。</p>'

  it('restores only the part the user asked for; the other change stays pending', async () => {
    const { resolveDiffMarkupInHtml } = await import('../../utils/diffResolution')
    useAppStore.setState({ documents: [doc('doc-1', '序章', ORIGINAL)], activeDocumentId: 'doc-1' })
    // Turn 1 rewrites both paragraphs; the user reviews nothing yet.
    responses.push(`改好了。\n<canvas>${P1_NEW}${P2_NEW}</canvas>\n<doc_status>updated</doc_status>`)
    responses.push('<doc_status>unchanged</doc_status>') // closes turn 1
    // Turn 2: "why did you change the second one? keep it as it was" — the
    // model restores that paragraph from the "was" text it is now shown.
    responses.push(`第二段改回原来的写法。\n<edit>\n<<<<<<< SEARCH\n${P2_NEW}\n=======\n<p>她站在窗边，没有回头。</p>\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>`)
    const h = renderChatHook()
    await send(h, '润色一下')
    const second = calls.length
    await send(h, '第二段为什么这么改？我想保留原来的写法')

    // The model was shown what each pending change replaced.
    const tail = calls[second].at(-1)?.content ?? ''
    expect(tail).toContain('PENDING CHANGES IN THIS CHAPTER')
    expect(tail).toContain('now: "她背对着门站在窗边，始终没有回头。"\n   was: "她站在窗边，没有回头。"')

    const content = (await import('../../utils/diff')).stripDiffMarkup(useAppStore.getState().documents[0].content)
    const stored = useAppStore.getState().documents[0].content
    // Accept-all: the first change, and the second paragraph as it was.
    expect(content).toBe(P1_NEW + '<p>她站在窗边，没有回头。</p>')
    // Reject-all: exactly what the user last confirmed — nothing was
    // accepted behind their back.
    expect(resolveDiffMarkupInHtml(stored, 'reject')).toBe(ORIGINAL)
    // The restored paragraph carries no diff; the first one still does.
    const [p1, p2] = stored.split('</p>')
    expect(p1).toMatch(/diff-(addition|deletion)/)
    expect(p2).not.toMatch(/diff-(addition|deletion)/)
    h.unmount()
  })
})

describe('a rewrite of the open chapter beside an outline edit (reported 2026-10-06)', () => {
  it('writes both in one reply, instead of losing the rewrite and writing it again', async () => {
    responses.push({ text: '', toolCalls: [{ index: 0, id: 'r1', name: 'read_chapter', argumentsText: '{"chapters":[3],"format":"html"}' }] })
    responses.push(`写好了，大纲也补上。\n<canvas><p>序章的新稿。</p></canvas>\n<edit chapter="3">\n<<<<<<< SEARCH\n${OUTLINE}\n=======\n<p>大纲：第一章，主角离开村子，回头看了一眼；第二章，进城。</p>\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>`)
    const h = renderChatHook()
    await send(h, '扩写序章，大纲也跟着改')

    expect(stripDiffMarkup(content('doc-1'))).toBe('<p>序章的新稿。</p>')
    expect(stripDiffMarkup(content('doc-2'))).toContain('回头看了一眼')
    // One write of the chapter, not two: the closing step writes nothing.
    expect(calls).toHaveLength(3)
    expect(bubble()?.content).not.toContain('could not')
    h.unmount()
  })
})

describe('writing another chapter (D2)', () => {
  it('refuses an edit on a chapter the model has not read, then lets it through after a read', async () => {
    const edit = '<edit chapter="3">\n<<<<<<< SEARCH\n<p>大纲：第一章，主角离开村子；第二章，进城。</p>\n=======\n<p>大纲：第一章，主角离家。</p>\n>>>>>>> REPLACE\n</edit>'
    responses.push(`改大纲。\n${edit}\n<doc_status>updated</doc_status>`)
    responses.push({ text: '', toolCalls: [{ index: 0, id: 'r1', name: 'read_chapter', argumentsText: '{"chapters":[3],"format":"html"}' }] })
    responses.push(`${edit}\n<doc_status>updated</doc_status>`)
    const h = renderChatHook()
    await send(h, '把大纲第一章改成离家')

    // Refused at step 1 — the model was told why.
    expect(calls[1].at(-1)?.content).toContain('read with chapters=')
    expect(stripDiffMarkup(content('doc-2'))).toBe('<p>大纲：第一章，主角离家。</p>')
    expect(content('doc-2')).toContain('diff-addition')
    // The open chapter is untouched, and the other one was snapshotted first.
    expect(content('doc-1')).toBe('<p>序章正文。</p>')
    expect(useAppStore.getState().versions.some(v => v.documentId === 'doc-2')).toBe(true)
    expect(bubble()?.agent?.touched).toEqual([{ documentId: 'doc-2', titleAtRun: '故事线', kind: 'edits', changes: 1, failed: 0 }])
    h.unmount()
  })

  it('never paints another chapter\'s rewrite into the open editor', async () => {
    const { editor, writes } = stubEditor('<p>序章正文。</p>')
    responses.push({ text: '', toolCalls: [{ index: 0, id: 'r1', name: 'read_chapter', argumentsText: '{"chapters":[3],"format":"html"}' }] })
    responses.push('<canvas chapter="3"><p>新大纲第一行</p><p>新大纲第二行</p></canvas>\n<doc_status>updated</doc_status>')
    const h = renderChatHook(editor)
    await send(h, '重写大纲')

    expect(writes.some(w => w.includes('新大纲'))).toBe(false)
    expect(stripDiffMarkup(content('doc-2'))).toBe('<p>新大纲第一行</p><p>新大纲第二行</p>')
    expect(useAppStore.getState().activeDocumentId).toBe('doc-1')
    h.unmount()
  })
})

describe('the user switching chapters mid-turn', () => {
  // What Editor.tsx does when the open chapter changes: load its content.
  const switchTo = (editor: { commands: { setContent: (c: string) => void } }, id: string) => {
    useAppStore.getState().setActiveDocumentId(id)
    editor.commands.setContent(content(id))
  }

  it('lands the rewrite in the chapter it was for, and never paints it over the one now open', async () => {
    const { editor, writes } = stubEditor('<p>序章正文。</p>')
    responses.push({
      text: '重写序章。\n<canvas><p>新的序章。</p></canvas>\n<doc_status>updated</doc_status>',
      between: () => switchTo(editor, 'doc-x')
    })
    const h = renderChatHook(editor)
    await send(h, '重写序章')

    expect(stripDiffMarkup(content('doc-1'))).toBe('<p>新的序章。</p>')
    expect(content('doc-x')).toBe('<p>主角：阿青。</p>')
    // After the switch the editor only ever showed the chapter that is open.
    const afterSwitch = writes.slice(writes.indexOf('<p>主角：阿青。</p>'))
    expect(afterSwitch.every(w => w === '<p>主角：阿青。</p>')).toBe(true)
    expect(useAppStore.getState().activeDocumentId).toBe('doc-x')
    h.unmount()
  })

  it('on Stop, keeps no draft and writes nothing into the chapter now open', async () => {
    const { editor, writes } = stubEditor('<p>序章正文。</p>')
    const abort = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
    responses.push({
      text: '重写序章。\n<canvas><p>写到一半',
      between: () => switchTo(editor, 'doc-x'),
      error: abort
    })
    const h = renderChatHook(editor)
    await send(h, '重写序章')

    // Without the fix, Stop rebuilt an undo step from the PREVIOUS chapter's
    // text inside the open one: 序章's original was written into its editor.
    const afterSwitch = writes.slice(writes.indexOf('<p>主角：阿青。</p>'))
    expect(afterSwitch).not.toContain('<p>序章正文。</p>')
    expect(content('doc-x')).toBe('<p>主角：阿青。</p>')
    expect(content('doc-1')).toBe('<p>序章正文。</p>')
    expect(bubble()?.content).toContain('⏹️ Stopped.')
    h.unmount()
  })
})

describe('creating a chapter (D6): creating IS writing', () => {
  it('creates the chapter as its text starts streaming, and writes it in the same step', async () => {
    // A lone create_chapter step planned the chapter for 105–158 s and the
    // writing step planned it again (2026-10-06): one call now does both.
    const { editor, writes } = stubEditor('<p>序章正文。</p>')
    const during: Array<{ count: number; open: string }> = []
    responses.push(streamed('我来写第一章。\n<canvas new_chapter="第一章 离乡"><p>第一章：主角离开村子。</p></canvas>\n<doc_status>updated</doc_status>', {
      between: () => {
        const st = useAppStore.getState()
        during.push({ count: st.documents.length, open: st.activeDocumentId })
      }
    }))
    responses.push('第一章写好了。')
    const h = renderChatHook(editor)
    await send(h, '根据大纲写第一章')

    const s = useAppStore.getState()
    const created = s.documents[3]
    expect(created.title).toBe('第一章 离乡')
    expect(stripDiffMarkup(created.content)).toBe('<p>第一章：主角离开村子。</p>')
    // Created and opened while the reply was still streaming: the live
    // preview ran in the new chapter.
    expect(during).toEqual([{ count: 4, open: created.id }])
    expect(writes.some(w => w.includes('第一章：主角离开村子'))).toBe(true)
    // One model call wrote it; the next only closed the turn.
    expect(calls).toHaveLength(2)
    expect(calls[1].at(-1)?.content).toContain('Created a NEW chapter #4 "第一章 离乡" at the end of the book and wrote it')
    // The open chapter before the turn was never touched.
    expect(content('doc-1')).toBe('<p>序章正文。</p>')
    expect(bubble()?.agent?.touched).toEqual([{ documentId: created.id, titleAtRun: '第一章 离乡', kind: 'created', changes: 1, failed: 0 }])
    expect(bubble()?.agent?.timeline).toContainEqual({ type: 'tool', line: '➕ wrote new #4 "第一章 离乡" (11 chars)', ok: true })
    h.unmount()
  })

  it('leaves no empty chapter behind when the write that created it did not land', async () => {
    const { editor } = stubEditor('<p>序章正文。</p>')
    // Cut off before the closing tag: the rewrite is refused as truncated.
    responses.push('<canvas new_chapter="第一章"><p>第一章写到一半')
    responses.push('写不下去了。\n<doc_status>unchanged</doc_status>')
    const h = renderChatHook(editor)
    await send(h, '写第一章')

    const s = useAppStore.getState()
    expect(s.documents.map(d => d.title)).toEqual(['序章', '人物表', '故事线'])
    expect(s.documents.some(d => d.id === s.activeDocumentId)).toBe(true)
    expect(bubble()?.agent?.touched).toEqual([])
    h.unmount()
  })
})

describe('the Polish button (D9)', () => {
  it('polishes the open chapter with the polish model, as a reviewable diff and a turn of its own', async () => {
    responses.push('<p>序章的正文。</p>')
    const h = renderChatHook()
    await act(async () => { useAppStore.getState().requestPolish('doc-1') })
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })

    // No chat model involved: one call, the polish model, its own cache key,
    // and no reasoning effort (grok-4.20 rejects the parameter).
    expect(configs).toEqual([{
      tools: undefined, toolChoice: undefined,
      model: 'grok-4.20-0309-reasoning', reasoningEffort: 'default', conversationId: 'book-test:polish'
    }])
    expect(stripDiffMarkup(content('doc-1'))).toBe('<p>序章的正文。</p>')
    expect(content('doc-1')).toContain('diff-addition')
    expect(useAppStore.getState().versions.some(v => v.documentId === 'doc-1')).toBe(true)

    const msgs = useAppStore.getState().messages
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[0].content).toContain('序章')
    expect(msgs[1].agent).toMatchObject({
      status: 'done',
      touched: [{ documentId: 'doc-1', kind: 'polished', changes: 1, failed: 0 }],
      timeline: [{ type: 'tool', ok: true }]
    })
    expect(useAppStore.getState().isStreaming).toBe(false)
    expect(useAppStore.getState().polishRequest).toBeNull()
    h.unmount()
  })

  it('leaves the chapter alone when the rewrite fails the checks', async () => {
    responses.push('<p>一段完全不同而且长得多的文字，明显超出了原文的篇幅。</p>')
    const h = renderChatHook()
    await act(async () => { useAppStore.getState().requestPolish('doc-1') })
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })

    expect(content('doc-1')).toBe('<p>序章正文。</p>')
    expect(useAppStore.getState().messages.at(-1)?.agent?.touched[0]).toMatchObject({ changes: 0, failed: 1 })
    h.unmount()
  })
})

describe('writing a series of chapters (one per reply)', () => {
  it('keeps going after a written chapter: the run reported 2026-10-06 that stopped after chapter one', async () => {
    const { editor, writes } = stubEditor('<p>序章正文。</p>')
    // A reply that holds only a write used to end the turn after chapter
    // one. Now the write's result goes back to the model — and each chapter
    // is created by the reply that writes it, one step per chapter.
    responses.push(streamed('<canvas new_chapter="第一章"><p>第一章正文。</p></canvas>\n<doc_status>updated</doc_status>'))
    responses.push(streamed('<canvas new_chapter="第二章"><p>第二章正文。</p></canvas>\n<doc_status>updated</doc_status>'))
    // The closing reply needs no declaration: it refers to the writes above.
    responses.push('两章都写完了。')
    const h = renderChatHook(editor)
    await send(h, '根据大纲写前两章')

    expect(calls).toHaveLength(3)
    expect(calls[0][0].content).toContain('ONE chapter per reply — you continue after each')
    // Step 2 saw step 1's result.
    expect(calls[1].at(-1)?.content).toContain('RESULT OF YOUR DOCUMENT CHANGES')
    const docs = useAppStore.getState().documents
    expect(stripDiffMarkup(docs[3].content)).toBe('<p>第一章正文。</p>')
    expect(stripDiffMarkup(docs[4].content)).toBe('<p>第二章正文。</p>')
    expect(writes.some(w => w.includes('第二章正文'))).toBe(true)
    expect(bubble()?.content).toContain('两章都写完了。')
    expect(bubble()?.content).not.toContain('⚠️')
    expect(bubble()?.agent?.status).toBe('done')
    expect(bubble()?.agent?.touched.map(t => [t.titleAtRun, t.kind, t.changes])).toEqual([
      ['第一章', 'created', 1], ['第二章', 'created', 1]
    ])
    h.unmount()
  })
  it('keeps the half-written second chapter on Stop: the preview followed the run to it', async () => {
    const { editor } = stubEditor('<p>序章正文。</p>')
    responses.push(streamed('<canvas new_chapter="第一章"><p>第一章正文。</p></canvas>\n<doc_status>updated</doc_status>'))
    responses.push(streamed('<canvas new_chapter="第二章"><p>第二章写到一半', { error: Object.assign(new Error('aborted'), { name: 'AbortError' }) }))
    const h = renderChatHook(editor)
    await send(h, '根据大纲写前两章')

    const docs = useAppStore.getState().documents
    expect(stripDiffMarkup(docs[3].content)).toBe('<p>第一章正文。</p>')
    // The preview created chapter two and painted into it, so Stop keeps the
    // draft there (and the end-of-run cleanup leaves a stopped run alone).
    expect(docs[4].title).toBe('第二章')
    expect(docs[4].content).toContain('第二章写到一半')
    expect(bubble()?.content).toContain('The partial draft was kept')
    h.unmount()
  })
})

describe('editing other chapters while the assistant writes (§0.4)', () => {
  const locked = () => {
    const s = useAppStore.getState()
    return [isEditLocked(s, 'doc-1'), isEditLocked(s, 'doc-x')]
  }

  it('locks only the chapter the preview paints, and only while it paints', async () => {
    const { editor } = stubEditor('<p>序章正文。</p>')
    const seen: boolean[][] = []
    responses.push({ text: '<canvas><p>新的序章。</p></canvas>\n<doc_status>updated</doc_status>', between: () => { seen.push(locked()) } })
    responses.push({ text: '好了。', between: () => { seen.push(locked()) } })
    const h = renderChatHook(editor)
    await send(h, '重写序章')

    // Step 1 paints 序章: it is read-only, 人物表 is not. Step 2 (the
    // closing reply) paints nothing: both are editable.
    expect(seen).toEqual([[true, false], [false, false]])
    expect(locked()).toEqual([false, false])
    h.unmount()
  })

  it('lets the user edit another chapter mid-turn: a write built on the stale copy is refused, then redone on their text', async () => {
    const edit = '<edit chapter="2">\n<<<<<<< SEARCH\n<p>主角：阿青。</p>\n=======\n<p>主角：阿青，十六岁。</p>\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>'
    const read = (id: string) => ({ text: '', toolCalls: [{ index: 0, id, name: 'read_chapter', argumentsText: '{"chapters":[2],"format":"html"}' }] })
    const seen: boolean[][] = []
    responses.push(read('r1'))
    responses.push({
      text: edit,
      // While the model writes, the user adds a line to 人物表.
      between: () => {
        seen.push(locked())
        useAppStore.getState().updateDocument('doc-x', { content: '<p>主角：阿青。</p><p>配角：阿红。</p>' })
      }
    })
    responses.push(read('r2'))
    responses.push(edit)
    const h = renderChatHook()
    await send(h, '给主角加上年龄')

    expect(seen).toEqual([[false, false]])
    // Step 3 was told why its edit did not land.
    expect(calls[2].at(-1)?.content).toContain('The user edited #2')
    // The user's line survived; the model's change is on top of it.
    expect(stripDiffMarkup(content('doc-x'))).toBe('<p>主角：阿青，十六岁。</p><p>配角：阿红。</p>')
    h.unmount()
  })

  it('stops moving the view once the user opened another chapter', async () => {
    responses.push({
      text: '',
      toolCalls: [{ index: 0, id: 'r1', name: 'read_chapter', argumentsText: '{"chapters":[3]}' }],
      between: () => useAppStore.getState().setActiveDocumentId('doc-2')
    })
    responses.push('<canvas new_chapter="第一章"><p>第一章正文。</p></canvas>\n<doc_status>updated</doc_status>')
    const h = renderChatHook()
    await send(h, '写第一章')

    // Created and written, but the view stays where the user put it.
    expect(useAppStore.getState().activeDocumentId).toBe('doc-2')
    expect(stripDiffMarkup(useAppStore.getState().documents[3].content)).toBe('<p>第一章正文。</p>')
    h.unmount()
  })
})

describe('grok keeps its reasoning from turn to turn', () => {
  const R = (n: number) => ({ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `C${n}==` })

  it('keeps the final step\'s reasoning items on the assistant message and sends them back in the next turn, ahead of its text', async () => {
    responses.push({ text: '好的，记下了。\n<doc_status>unchanged</doc_status>', responseItems: [R(1), { type: 'message', id: 'msg_1' }] })
    const h = renderChatHook()
    await send(h, '记住一个秘密')
    const stored = useAppStore.getState().messages.filter(m => m.role === 'assistant').at(-1)
    // Only the reasoning: a message item would put raw markup into history.
    expect(stored?.reasoningItems).toEqual([R(1)])

    responses.push('是的。\n<doc_status>unchanged</doc_status>')
    await send(h, '秘密是什么？')
    // Not the ledger's "Understood…" prefix message: the previous turn's reply,
    // replayed from its transcript with its items as returned (cache_continuity.md §3.1).
    const previous = calls[1].find(m => m.role === 'assistant' && m.content.includes('好的，记下了。'))
    expect(previous?.responseItems).toEqual([R(1), { type: 'message', id: 'msg_1' }])
    h.unmount()
  })

  it('sends only the most recent turns\' items', async () => {
    const { REASONING_HISTORY_TURNS } = await import('../useChatLLM')
    const old = Array.from({ length: REASONING_HISTORY_TURNS + 2 }, (_, i) => [
      { id: `u${i}`, role: 'user' as const, content: `问题 ${i}`, timestamp: '2026-10-08T00:00:00.000Z' },
      { id: `a${i}`, role: 'assistant' as const, content: `回答 ${i}`, timestamp: '2026-10-08T00:00:00.000Z', reasoningItems: [R(i)] }
    ]).flat()
    useAppStore.setState({ messages: [...useAppStore.getState().messages, ...old] })
    responses.push('好。\n<doc_status>unchanged</doc_status>')
    const h = renderChatHook()
    await send(h, '再问一个')
    const carried = calls[0].filter(m => m.role === 'assistant' && m.responseItems?.length)
    expect(carried).toHaveLength(REASONING_HISTORY_TURNS)
    expect(carried[0].content).toContain('回答 2')
    h.unmount()
  })
})

describe('grok keeps its reasoning from step to step (xAI Responses API)', () => {
  it('sends each step\'s output items back on its assistant message in the next request', async () => {
    const ITEMS = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'CIPHER==' },
      { type: 'function_call', call_id: 'r1', name: 'read_chapter', arguments: '{"chapters":[3]}' }
    ]
    responses.push({ text: '', toolCalls: [{ index: 0, id: 'r1', name: 'read_chapter', argumentsText: '{"chapters":[3]}' }], responseItems: ITEMS })
    responses.push('读完了。\n<doc_status>unchanged</doc_status>')
    const h = renderChatHook()
    await send(h, '读大纲')

    expect(calls).toHaveLength(2)
    // The step's own reply: the last assistant message (history comes first).
    const assistant = calls[1].filter(m => m.role === 'assistant').at(-1)
    expect(assistant?.responseItems).toEqual(ITEMS)
    expect(assistant?.toolCalls?.[0]).toMatchObject({ id: 'r1', name: 'read_chapter' })
    h.unmount()
  })
})

describe('the step limit (D5)', () => {
  it('sends the last allowed step with tool calls disabled and says the turn stopped there', async () => {
    const s = useAppStore.getState()
    useAppStore.setState({ providerConfigs: { ...s.providerConfigs, grok: { ...s.providerConfigs.grok, agentMaxSteps: 2 } } })
    const reading = { text: '', toolCalls: [{ index: 0, id: 'r', name: 'read_chapter', argumentsText: '{"chapters":[3]}' }] }
    responses.push(reading, reading)
    const h = renderChatHook()
    await send(h, '读遍全书')

    expect(calls).toHaveLength(2)
    expect(configs[0].toolChoice).toBeUndefined()
    expect(configs[1].toolChoice).toBe('none')
    expect(calls[1].at(-1)?.content).toContain('step budget')
    expect(bubble()?.content).toContain('step limit')
    expect(bubble()?.agent?.status).toBe('step_limit')
    useAppStore.setState({ providerConfigs: s.providerConfigs })
    h.unmount()
  })
})
