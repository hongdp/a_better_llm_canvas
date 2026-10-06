/**
 * A ToolContext with no editor and no store: every port records what it was
 * asked to do. Lives under __tests__ without the `.test.ts` suffix, so the
 * runner imports it but never runs it as a suite.
 */
import { vi } from 'vitest'
import type { AppState } from '../../store/types'
import type { ToolContext } from '../types'

export interface FakeContextOptions {
  /** HTML the fake editor holds; null = no editor mounted. */
  editorHtml?: string | null
  /** The selection range, or null for none. */
  selection?: { from: number; to: number } | null
  /** What replaceRange returns: an end position, or null for "selection gone". */
  replaceRangeResult?: number | null
  /** The editor's HTML after replaceRange writes `html` (default: just `html`). */
  afterReplace?: (html: string) => string
}

export function fakeContext(original: string, opts: FakeContextOptions = {}) {
  const commits: string[] = []
  let editorHtml = opts.editorHtml === undefined ? null : opts.editorHtml
  const previewDocument = vi.fn()
  const previewSelection = vi.fn()
  const ctx: ToolContext = {
    getState: () => ({}) as AppState,
    editor: {
      current: () => (editorHtml === null ? null : { getHTML: () => editorHtml as string }),
      previewDocument,
      previewSelection,
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
      originalText: () => ''
    },
    document: { original, commit: html => { commits.push(html) } },
    images: { preserve: h => h, restore: h => h },
    run: { working: null, selectionAttempted: false, selectionApplied: false }
  }
  return { ctx, commits, previewDocument, previewSelection, lastCommit: () => commits[commits.length - 1] }
}
