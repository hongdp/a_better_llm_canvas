/**
 * A Ctrl+A selection rewrite, end to end: real hook, real TipTap editor,
 * the markup protocol streamed in small chunks so the live preview runs
 * many ticks. This is the user-reported case — "Elaborate" on a whole
 * chapter with images left scrambled characters after the new text.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { DOMSerializer } from '@tiptap/pm/model'
import type { LLMMessage } from '../../types/llm'

const responses: string[][] = []
vi.mock('../../services/llm', () => ({
  streamLLM: async (
    _m: LLMMessage[],
    _c: unknown,
    cb: { onChunk: (c: string) => void; onDone: (t: string, u?: unknown) => void }
  ) => {
    const chunks = responses.shift() ?? []
    let full = ''
    for (const ch of chunks) {
      full += ch
      cb.onChunk(ch)
      // Past the preview throttle on every chunk.
      vi.setSystemTime(Date.now() + 300)
    }
    cb.onDone(full, { promptTokens: 10, completionTokens: 20 })
  }
}))
vi.mock('../../services/chapterSummaries', () => ({ enqueueStaleSummaryRefreshes: vi.fn() }))

import { useChatLLM } from '../useChatLLM'
import { useAppStore } from '../../store/useAppStore'
import { CustomImage, DiffAddition, DiffDeletion } from '../../components/editorExtensions'
import { replaceImagesWithPlaceholders, type ImagePlaceholderEntry } from '../../utils/imagePreservation'
import { stripDiffMarkup } from '../../utils/diff'

const extensions = [StarterKit.configure({ strike: false }), DiffAddition, DiffDeletion, CustomImage]
const realEditor = (content: string) =>
  new Editor({ element: document.createElement('div'), extensions, content })

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

const BEFORE = '<p>第一段，原来的。</p><p><img src="a.png"></p><p>第二段，原来的。</p><p><img src="b.png"></p><p>第三段，原来的。</p>'
const AFTER = '<p>第一段，展开写细了：身体、动作、对话都补上了。</p><p><img src="a.png"></p><p>第二段，同样拉开了篇幅，加了心理描写。</p><p><img src="b.png"></p><p>第三段，收尾更完整，余韵更长。</p>'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
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

describe('selection rewrite of a Ctrl+A selection', () => {
  it('streams a whole-chapter rewrite with images and leaves no residue', async () => {
    const editor = realEditor(BEFORE)
    const editorBefore = editor.getHTML()
    useAppStore.setState({
      documents: [{ id: 'doc-1', title: '第四章', content: editorBefore, contentLoaded: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
      activeDocumentId: 'doc-1'
    })
    editor.commands.selectAll()
    expect(editor.state.selection.from).toBe(0)

    // The model answers in the placeholder form it was shown.
    const registry: ImagePlaceholderEntry[] = []
    replaceImagesWithPlaceholders(editorBefore, registry)
    const expected = realEditor(AFTER).getHTML()
    const raw = '好的。\n<selection_replace>' + replaceImagesWithPlaceholders(expected, registry) + '</selection_replace>\n<doc_status>updated</doc_status>'
    const chunks: string[] = []
    for (let i = 0; i < raw.length; i += 12) chunks.push(raw.slice(i, i + 12))
    responses.push(chunks)

    const h = renderHook(editor, selectionHtml(editor))
    await act(async () => { await h.current.handleSendMessage(undefined, 'Elaborate on the selected text, adding more detail and depth.') })
    await act(async () => { await Promise.resolve() })

    // Accepting every change must give exactly the model's text — nothing
    // trailing, nothing scrambled — and the store must hold what is shown.
    expect(stripDiffMarkup(editor.getHTML())).toBe(expected)
    const stored = useAppStore.getState().documents[0].content
    expect(stored).toBe(editor.getHTML())
    expect(stored).toContain('diff-addition')

    h.unmount()
    editor.destroy()
  })
})
