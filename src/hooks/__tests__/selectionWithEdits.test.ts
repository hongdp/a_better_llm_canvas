/**
 * A selection rewrite that comes with <edit> blocks for text OUTSIDE the
 * selection, end to end: real hook, real TipTap editor.
 *
 * Reported: the model rewrote the selected passage and, in the same reply,
 * smoothed a sentence further down with an <edit>. The channels were
 * exclusive, so the edit was shown raw in the chat bubble and never applied.
 * Both must now land, each as a reviewable diff, with nothing raw in the chat.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { DOMSerializer } from '@tiptap/pm/model'
import type { LLMMessage } from '../../types/llm'

type ToolDelta = { index: number; name?: string; argumentsText: string }
type Scripted = { chunks: string[]; toolCalls?: ToolDelta[]; beforeDone?: () => void; afterChunk?: (index: number) => void }
const responses: Scripted[] = []
const requests: LLMMessage[][] = []
vi.mock('../../services/llm', () => ({
  streamLLM: async (
    _m: LLMMessage[],
    _c: unknown,
    cb: {
      onChunk: (c: string) => void
      onDone: (t: string, u?: unknown) => void
      onToolCallDelta?: (d: ToolDelta) => void
    }
  ) => {
    requests.push(_m)
    const r = responses.shift() ?? { chunks: [] }
    let full = ''
    r.chunks.forEach((ch, i) => {
      full += ch
      cb.onChunk(ch)
      vi.setSystemTime(Date.now() + 300)   // past the preview throttle
      r.afterChunk?.(i)
    })
    for (const d of r.toolCalls ?? []) cb.onToolCallDelta?.(d)
    r.beforeDone?.()
    cb.onDone(full, { promptTokens: 10, completionTokens: 20 })
  }
}))
vi.mock('../../services/chapterSummaries', () => ({ enqueueStaleSummaryRefreshes: vi.fn() }))

import { useChatLLM } from '../useChatLLM'
import { useAppStore } from '../../store/useAppStore'
import { CustomImage, DiffAddition, DiffDeletion } from '../../components/editorExtensions'
import { stripDiffMarkup } from '../../utils/diff'

const extensions = [StarterKit.configure({ strike: false }), DiffAddition, DiffDeletion, CustomImage]
const realEditor = (content: string) => new Editor({ element: document.createElement('div'), extensions, content })
const normalize = (html: string) => { const e = realEditor(html); const out = e.getHTML(); e.destroy(); return out }

/** What Editor.tsx publishes as selectedText: the selected slice as HTML. */
function selectionHtml(editor: Editor): string {
  const { from, to } = editor.state.selection
  const div = document.createElement('div')
  div.appendChild(DOMSerializer.fromSchema(editor.state.schema).serializeFragment(editor.state.doc.slice(from, to).content))
  return div.innerHTML
}

function renderHook(editor: Editor, selectedText: string) {
  const h = { current: null as unknown as ReturnType<typeof useChatLLM>, unmount: () => {} }
  const Probe = () => {
    h.current = useChatLLM({
      activeEditor: editor, selectedText, uploadedImages: [], setUploadedImages: vi.fn(),
      layoutMode: 'landscape', setIsChatExpanded: vi.fn(), forceSave: vi.fn(), setSaveStatus: vi.fn()
    })
    return null
  }
  let root: Root
  act(() => { root = createRoot(document.createElement('div')); root.render(createElement(Probe)) })
  h.unmount = () => act(() => root.unmount())
  return h
}

const DOC = '<p>开头的一段话。</p><p>被选中的这一段文字。</p><p>中间保持不变的一段。</p><p>后面需要衔接的一句话。</p>'
const SEL_NEW = '<p>被选中的这一段文字，补上了更多细节。</p>'
const EDIT_SEARCH = '<p>后面需要衔接的一句话。</p>'
const EDIT_REPLACE = '<p>后面已经顺利衔接上的一句话。</p>'
const EXPECTED = normalize('<p>开头的一段话。</p>' + SEL_NEW + '<p>中间保持不变的一段。</p>' + EDIT_REPLACE)
const editMarkup = (search: string, replace: string) =>
  `<edit>\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n</edit>`

/** Put DOC in the editor and the store, and select the second paragraph's text. */
function setup() {
  const editor = realEditor(DOC)
  useAppStore.setState({
    documents: [{ id: 'doc-1', title: '第一章', content: editor.getHTML(), contentLoaded: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
    activeDocumentId: 'doc-1'
  })
  const from = editor.state.doc.child(0).nodeSize + 1
  editor.commands.setTextSelection({ from, to: from + editor.state.doc.child(1).content.size })
  return { editor, selectedText: selectionHtml(editor) }
}

async function send(editor: Editor, selectedText: string) {
  const h = renderHook(editor, selectedText)
  await act(async () => { await h.current.handleSendMessage(undefined, '补充细节，并让后文衔接上。') })
  await act(async () => { await Promise.resolve() })
  return h
}

const stored = () => useAppStore.getState().documents[0].content
/**
 * In this bare-editor harness, rewriting the text of ONE paragraph leaves an
 * empty <p></p> in front of it. That is the selection write's own behaviour
 * here — measured identical with the code before this change — and the real
 * chapter the bug was reported on shows none, so it is not what these tests
 * are about. Compared without it.
 */
const accepted = (html: string) => stripDiffMarkup(html).replace(/<p><\/p>/g, '')
const bubble = () => useAppStore.getState().messages.filter(m => m.role === 'assistant').at(-1)?.content ?? ''
const RAW_MARKUP = /<edit|<{5,}|={5,}|>{5,}|<canvas|<selection_replace/

beforeEach(() => {
  responses.length = 0
  requests.length = 0
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useAppStore.setState({
    messages: [], versions: [], isStreaming: false, user: null, activeBookId: 'book-test',
    wholeBookMode: 'off', pinnedReferenceIds: [], blockedReferenceIds: [], debugMode: false,
    activeSystemPromptId: 'prompt-none', customSystemPrompts: [{ id: 'prompt-none', name: 'None', content: '' }]
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a selection rewrite with an edit beside it', () => {
  it('applies both, each as a pending diff, and keeps the chat clean (markup protocol)', async () => {
    const { editor, selectedText } = setup()
    const raw = `好的。\n<selection_replace>${SEL_NEW}</selection_replace>\n${editMarkup(EDIT_SEARCH, EDIT_REPLACE)}\n<doc_status>updated</doc_status>`
    const chunks: string[] = []
    for (let i = 0; i < raw.length; i += 16) chunks.push(raw.slice(i, i + 16))
    responses.push({ chunks })

    const h = await send(editor, selectedText)

    // Accepting every change gives the selection rewrite AND the edit.
    expect(accepted(stored())).toBe(EXPECTED)
    // Both are still up for review: neither was folded in as accepted.
    const middle = stored().indexOf('中间保持不变的一段。')
    expect(stored().slice(0, middle)).toMatch(/diff-(?:addition|deletion)/)
    expect(stored().slice(middle)).toMatch(/diff-(?:addition|deletion)/)
    // Untouched text stays exactly where it was.
    expect(stored().startsWith('<p>开头的一段话。</p>')).toBe(true)
    expect(bubble()).toBe('好的。')
    h.unmount(); editor.destroy()
  })

  it('applies two continuity edits that land in the same paragraph', async () => {
    // The second used to be refused: the first had marked that paragraph.
    const { editor, selectedText } = setup()
    const later = '<p>后面需要衔接的一句话。</p>'
    responses.push({ chunks: [
      `好的。\n<selection_replace>${SEL_NEW}</selection_replace>\n` +
      editMarkup('后面需要', '后面已经') + '\n' + editMarkup('一句话。', '一个句子。') +
      `\n<doc_status>updated</doc_status>`
    ] })

    const h = await send(editor, selectedText)

    expect(accepted(stored())).toBe(normalize('<p>开头的一段话。</p>' + SEL_NEW + '<p>中间保持不变的一段。</p><p>后面已经衔接的一个句子。</p>'))
    expect(stored()).not.toContain(later)
    expect(bubble()).toBe('好的。')
    h.unmount(); editor.destroy()
  })

  it('applies both through the tool protocol (replace_selection + edit_document)', async () => {
    const { editor, selectedText } = setup()
    responses.push({
      chunks: ['好的。'],
      toolCalls: [
        { index: 0, name: 'replace_selection', argumentsText: JSON.stringify({ html: SEL_NEW }) },
        { index: 1, name: 'edit_document', argumentsText: JSON.stringify({ edits: [{ search: EDIT_SEARCH, replace: EDIT_REPLACE }] }) }
      ]
    })

    const h = await send(editor, selectedText)

    expect(accepted(stored())).toBe(EXPECTED)
    expect(bubble()).toBe('好的。')
    h.unmount(); editor.destroy()
  })

  it('hands an edit it cannot locate back to the model, which fixes it, and keeps the selection', async () => {
    // The agentic loop (spec D3): an unmatched SEARCH is a failure the model
    // can fix, so it is fed back instead of ending the turn with a warning.
    const { editor, selectedText } = setup()
    responses.push({ chunks: [`好的。\n<selection_replace>${SEL_NEW}</selection_replace>\n${editMarkup('<p>文档里并没有这一句。</p>', EDIT_REPLACE)}`] })
    responses.push({ chunks: [`改正了衔接句。\n${editMarkup(EDIT_SEARCH, EDIT_REPLACE)}\n<doc_status>updated</doc_status>`] })

    const h = await send(editor, selectedText)
    await act(async () => { await Promise.resolve() })

    expect(requests).toHaveLength(2)
    // The second step was told exactly which SEARCH text failed.
    expect(requests[1].at(-1)?.content).toContain('<p>文档里并没有这一句。</p>')
    expect(accepted(stored())).toBe(EXPECTED)
    expect(bubble()).not.toMatch(RAW_MARKUP)
    // Fixed, so nothing to warn about.
    expect(bubble()).not.toContain('could not be located')
    h.unmount(); editor.destroy()
  })

  it('drops a canvas written beside the selection, says so, and never shows it', async () => {
    const { editor, selectedText } = setup()
    responses.push({ chunks: [`好的。\n<selection_replace>${SEL_NEW}</selection_replace>\n<canvas><p>一整篇别的东西</p></canvas>`] })

    const h = await send(editor, selectedText)

    expect(stored()).not.toContain('一整篇别的东西')
    expect(bubble()).not.toMatch(RAW_MARKUP)
    expect(bubble()).toContain('This reply also contained 1 document change')
    h.unmount(); editor.destroy()
  })
})

// The completion notes used to be built BEFORE the document writes, while
// selectionGoneRef is only set BY them — so this note could never appear.
describe('a selection that disappeared while the reply streamed', () => {
  it('says the selection is gone and reports the edits beside it as not applied', async () => {
    const { editor, selectedText } = setup()
    responses.push({
      chunks: [`好的。\n<selection_replace>${SEL_NEW}</selection_replace>\n${editMarkup(EDIT_SEARCH, EDIT_REPLACE)}`],
      // The chapter changes under the reply before it completes.
      beforeDone: () => { editor.commands.setContent('<p>短</p>') }
    })

    const h = await send(editor, selectedText)

    expect(bubble()).toContain('no longer where it was')
    expect(bubble()).toContain('1 suggested change could not be located')
    expect(bubble()).not.toMatch(RAW_MARKUP)
    h.unmount(); editor.destroy()
  })
})

// Switching chapters mid-turn is allowed (agentic loop, D2). A selection
// preview writes REAL transactions at the selection's offsets, so it must stop
// the moment the editor shows another chapter.
describe('the user switching chapters during a selection rewrite', () => {
  it('stops previewing into the chapter now open, and reports the selection as gone', async () => {
    const { editor, selectedText } = setup()
    // Longer than the selection's offsets, so a stray preview WOULD land in it.
    const OTHER = '<p>第二章第一段，是一段比较长的文字，足够容纳原来选区的位置。</p><p>第二章第二段，同样足够长，不会让写入因为越界而落空。</p><p>第二章第三段。</p>'
    useAppStore.setState(st => ({
      documents: [...st.documents, { id: 'doc-2', title: '第二章', content: OTHER, contentLoaded: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }]
    }))
    responses.push({
      chunks: ['好的。\n<selection_replace><p>被选中的这一段', '文字，补上了更多细节。</p>', '</selection_replace>\n<doc_status>updated</doc_status>'],
      afterChunk: i => {
        if (i !== 0) return
        // The user clicks chapter 2; Editor.tsx loads it into the editor.
        useAppStore.getState().setActiveDocumentId('doc-2')
        editor.commands.setContent(OTHER)
      }
    })

    const h = await send(editor, selectedText)

    expect(editor.getHTML()).toBe(normalize(OTHER))
    expect(useAppStore.getState().documents.find(d => d.id === 'doc-2')?.content).toBe(OTHER)
    expect(bubble()).toContain('no longer where it was')
    h.unmount(); editor.destroy()
  })
})
