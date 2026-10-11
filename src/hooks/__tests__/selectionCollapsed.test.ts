/**
 * A selection rewrite when the editor's live selection is no longer the text
 * the request is about, end to end: real hook, real TipTap editor.
 *
 * Reported (2026-10-11): the store still held the passage selected earlier
 * while the editor's selection had collapsed to a cursor in paragraph 2 (a
 * stopped turn, a click). The range captured at send was [cursor, cursor],
 * and the rewrite of the chapter's last scene was inserted into paragraph 2
 * after "扶", the old ending left in place. The rewrite must land on the text
 * the request was about, or report that it is gone — never at the cursor.
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

const DOC = '<p>开头的一段话，光标后来停在这里。</p><p>被选中的这一段文字。</p><p>后面保持不变的一段。</p>'
const SEL_NEW = '<p>被选中的这一段文字，重写之后的版本。</p>'

/** Put DOC in the editor and the store, select the second paragraph, then move the cursor away. */
function setup(collapseTo: number | null = 3) {
  const editor = realEditor(DOC)
  useAppStore.setState({
    documents: [{ id: 'doc-1', title: '第一章', content: editor.getHTML(), contentLoaded: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }],
    activeDocumentId: 'doc-1'
  })
  const from = editor.state.doc.child(0).nodeSize + 1
  editor.commands.setTextSelection({ from, to: from + editor.state.doc.child(1).content.size })
  const selectedText = selectionHtml(editor)
  // What Editor.tsx published is still in the store; the editor's own selection has moved on.
  if (collapseTo !== null) editor.commands.setTextSelection(collapseTo)
  return { editor, selectedText }
}

async function send(editor: Editor, selectedText: string) {
  const h = renderHook(editor, selectedText)
  await act(async () => { await h.current.handleSendMessage(undefined, '重写选中的这段。') })
  await act(async () => { await Promise.resolve() })
  return h
}

const stored = () => useAppStore.getState().documents[0].content
const accepted = (html: string) => stripDiffMarkup(html).replace(/<p><\/p>/g, '')
const bubble = () => useAppStore.getState().messages.filter(m => m.role === 'assistant').at(-1)?.content ?? ''

beforeEach(() => {
  responses.length = 0
  requests.length = 0
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useAppStore.setState({
    messages: [], versions: [], isStreaming: false, user: null, activeBookId: 'book-test', debugMode: false,
    activeSystemPromptId: 'prompt-none', customSystemPrompts: [{ id: 'prompt-none', name: 'None', content: '' }]
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a selection rewrite whose live selection has moved', () => {
  it('lands on the text the request was about, not at the cursor', async () => {
    const { editor, selectedText } = setup(3)
    responses.push({ chunks: [`好的。\n<selection_replace>${SEL_NEW}</selection_replace>\n<doc_status>updated</doc_status>`] })

    const h = await send(editor, selectedText)

    expect(accepted(stored())).toBe(normalize('<p>开头的一段话，光标后来停在这里。</p>' + SEL_NEW + '<p>后面保持不变的一段。</p>'))
    expect(stored().startsWith('<p>开头的一段话，光标后来停在这里。</p>')).toBe(true)
    expect(bubble()).toBe('好的。')
    h.unmount(); editor.destroy()
  })

  it('still uses the live selection when it is that text', async () => {
    const { editor, selectedText } = setup(null)
    responses.push({ chunks: [`好的。\n<selection_replace>${SEL_NEW}</selection_replace>\n<doc_status>updated</doc_status>`] })

    const h = await send(editor, selectedText)

    expect(accepted(stored())).toBe(normalize('<p>开头的一段话，光标后来停在这里。</p>' + SEL_NEW + '<p>后面保持不变的一段。</p>'))
    h.unmount(); editor.destroy()
  })

  it('writes nothing when the text is no longer in the document, and says so', async () => {
    const { editor } = setup(3)
    const before = stored()
    responses.push({ chunks: [`好的。\n<selection_replace>${SEL_NEW}</selection_replace>\n<doc_status>updated</doc_status>`] })

    const h = await send(editor, '<p>一段早已不在文档里的文字。</p>')

    expect(stored()).toBe(before)
    expect(bubble()).not.toMatch(/<selection_replace/)
    expect(bubble()).toMatch(/selected|selection/i)
    h.unmount(); editor.destroy()
  })
})
