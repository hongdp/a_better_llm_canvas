/**
 * A ToolContext over an in-memory book: no editor component and no store, and
 * every port records what it was asked to do. Lives under __tests__ without
 * the `.test.ts` suffix, so the runner imports it but never runs it as a suite.
 */
import { vi } from 'vitest'
import type { AppState } from '../../store/types'
import { createRunState, type BookChapter, type ToolContext } from '../types'

export interface FakeContextOptions {
  /** HTML the fake editor holds; null = no editor mounted. */
  editorHtml?: string | null
  /** The selection range, or null for none. */
  selection?: { from: number; to: number } | null
  /** What replaceRange returns: an end position, or null for "selection gone". */
  replaceRangeResult?: number | null
  /** The editor's HTML after replaceRange writes `html` (default: just `html`). */
  afterReplace?: (html: string) => string
  /** Further chapters after the start chapter (which is `doc-1`, "Chapter 1"). */
  chapters?: BookChapter[]
  /** Chapter ids whose full text the request already carries. */
  inContext?: string[]
  /** Chapter ids whose content has not "loaded" until ensureLoaded is called. */
  lazy?: Record<string, string>
  /** The selected text of a selection turn ('' = none). */
  selectedText?: string
}

export function fakeContext(original: string, opts: FakeContextOptions = {}) {
  const commits: string[] = []
  /** Every commit, with the chapter it went to. */
  const writes: Array<{ id: string; html: string }> = []
  const snapshots: string[] = []
  const opened: string[] = []
  const removed: string[] = []
  const progress: Array<string | null> = []
  /** Every ui.writing call: the chapter locked for a slow write, or null. */
  const writing: Array<string | null> = []
  let userMoved = false
  let editorHtml = opts.editorHtml === undefined ? null : opts.editorHtml
  let openId = 'doc-1'
  const book: BookChapter[] = [
    { id: 'doc-1', title: 'Chapter 1', content: original },
    ...(opts.chapters ?? [])
  ]
  const lazy = { ...(opts.lazy ?? {}) }
  const previewDocument = vi.fn()
  const previewSelection = vi.fn()
  const discardPreview = vi.fn()
  const ensureLoaded = vi.fn(async (ids: string[]) => {
    for (const id of ids) {
      if (lazy[id] === undefined) continue
      const chapter = book.find(c => c.id === id)
      if (chapter) chapter.content = lazy[id]
      delete lazy[id]
    }
  })
  let created = 0

  const ctx: ToolContext = {
    getState: () => ({}) as AppState,
    editor: {
      current: () => (editorHtml === null ? null : { getHTML: () => editorHtml as string }),
      previewDocument,
      previewSelection,
      discardPreview,
      replaceRange: (_from, _to, html) => {
        const result = opts.replaceRangeResult === undefined ? 1 : opts.replaceRangeResult
        if (result !== null) editorHtml = opts.afterReplace ? opts.afterReplace(html) : html
        return result
      }
    },
    selection: {
      relocate: () => {},
      range: () => opts.selection ?? null,
      end: () => opts.selection?.to ?? null,
      originalText: () => opts.selectedText ?? ''
    },
    document: {
      startId: 'doc-1',
      original,
      chapters: () => book.map(c => ({ ...c, loaded: lazy[c.id] === undefined })),
      openId: () => openId,
      userMoved: () => userMoved,
      ensureLoaded,
      commit: (id, html) => {
        writes.push({ id, html })
        if (id === 'doc-1') commits.push(html)
        const chapter = book.find(c => c.id === id)
        if (chapter) chapter.content = html
      },
      open: id => { openId = id; opened.push(id) },
      create: title => {
        const id = `new-${++created}`
        book.push({ id, title, content: '<p></p>' })
        return id
      },
      snapshot: id => { snapshots.push(id) },
      remove: id => {
        removed.push(id)
        const i = book.findIndex(c => c.id === id)
        if (i !== -1) book.splice(i, 1)
        if (openId === id) openId = book[0]?.id ?? ''
      }
    },
    images: { preserve: h => h, restore: h => h },
    ui: { progress: line => { progress.push(line) }, writing: id => { writing.push(id) } },
    run: createRunState({ startId: 'doc-1', inContext: opts.inContext, startContent: original })
  }
  return {
    ctx, commits, writes, snapshots, opened, removed, progress, writing, previewDocument, previewSelection, discardPreview, ensureLoaded,
    book: () => book,
    /** The user types into a chapter (the stored content changes outside the run). */
    userEdits: (id: string, html: string) => {
      const chapter = book.find(c => c.id === id)
      if (chapter) chapter.content = html
    },
    /** The user opens another chapter. */
    userOpens: (id: string) => { openId = id; userMoved = true },
    lastCommit: () => commits[commits.length - 1],
    lastWrite: (id: string) => [...writes].reverse().find(w => w.id === id)?.html
  }
}
