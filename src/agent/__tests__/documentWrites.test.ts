import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stripDiffMarkup, diffHtml } from '../../utils/diff'
import { updateDocumentTool, editDocumentTool, replaceSelectionTool } from '../tools/documentWrites'
import type { ToolInvocation } from '../types'
import { fakeContext } from './fakeContext'

const call = (name: string, args: Record<string, unknown> | null, extra: Partial<ToolInvocation> = {}): ToolInvocation =>
  ({ id: `c-${name}`, name, args, source: 'native', ...extra })

const edit = (search: string, replace: string) => ({ edits: [{ search, replace }] })
/** Diff ids are random per call; compare the markup without them. */
const ids = (html: string) => html.replace(/data-diff-id="[^"]*"/g, 'data-diff-id=""')

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('writes compose on the run working copy', () => {
  it('lets a second edit match text the first edit wrote', () => {
    const f = fakeContext('<p>alpha</p><p>beta</p>')
    editDocumentTool.invoke(call('edit_document', edit('<p>alpha</p>', '<p>ALPHA</p>')), f.ctx)
    const second = editDocumentTool.invoke(call('edit_document', edit('<p>ALPHA</p>', '<p>ALPHA two</p>')), f.ctx)

    expect(second).toMatchObject({ ok: true, effects: { failedEdits: 0 } })
    expect(stripDiffMarkup(f.lastCommit())).toBe('<p>ALPHA two</p><p>beta</p>')
    // One review diff against what the turn found, not a diff of a diff.
    expect(ids(f.lastCommit())).toBe(ids(diffHtml('<p>alpha</p><p>beta</p>', '<p>ALPHA two</p><p>beta</p>')))
  })

  it('applies an edit on top of a full rewrite from the same run', () => {
    const f = fakeContext('<p>old</p>')
    updateDocumentTool.invoke(call('update_document', { html: '<p>new one</p><p>new two</p>' }), f.ctx)
    editDocumentTool.invoke(call('edit_document', edit('<p>new two</p>', '<p>new 2</p>')), f.ctx)

    expect(stripDiffMarkup(f.lastCommit())).toBe('<p>new one</p><p>new 2</p>')
  })

  it('matches against the accepted reading of a pending diff', () => {
    const pending = diffHtml('<p>intro</p><p>old dup</p>', '<p>intro</p><p>dup para</p>')
    const f = fakeContext(pending)
    const result = editDocumentTool.invoke(call('edit_document', edit('<p>dup para</p>', '')), f.ctx)

    expect(result).toMatchObject({ ok: true })
    expect(stripDiffMarkup(f.lastCommit())).toBe('<p>intro</p>')
  })

  it('puts the original back when no edit matches and nothing else was written', () => {
    const f = fakeContext('<p>alpha</p>')
    const result = editDocumentTool.invoke(call('edit_document', edit('<p>missing</p>', '<p>x</p>')), f.ctx)

    expect(result).toMatchObject({ ok: false, effects: { failedEdits: 1 } })
    expect(f.lastCommit()).toBe('<p>alpha</p>')
    // The failed SEARCH is in what the model would read next step.
    expect((result as { content: string }).content).toContain('<p>missing</p>')
  })

  it('keeps an earlier write when a later edit fails', () => {
    const f = fakeContext('<p>alpha</p>')
    updateDocumentTool.invoke(call('update_document', { html: '<p>rewritten</p>' }), f.ctx)
    editDocumentTool.invoke(call('edit_document', edit('<p>missing</p>', '<p>x</p>')), f.ctx)

    expect(stripDiffMarkup(f.lastCommit())).toBe('<p>rewritten</p>')
  })
})

describe('update_document guards', () => {
  it('refuses a rewrite whose closing tag never arrived', () => {
    const f = fakeContext('<p>keep me</p>')
    const result = updateDocumentTool.invoke(call('update_document', { html: '<p>half' }, { source: 'markup', unclosed: true }), f.ctx)

    expect(result).toMatchObject({ ok: false, effects: { canvasIssue: 'truncated' } })
    expect(f.lastCommit()).toBe('<p>keep me</p>')
  })

  it('treats arguments that never parsed as a truncated rewrite, not as silence', () => {
    const f = fakeContext('<p>keep me</p>')
    const result = updateDocumentTool.invoke(call('update_document', null), f.ctx)

    expect(result).toMatchObject({ ok: false, effects: { canvasIssue: 'truncated' } })
  })

  it('reports an empty rewrite as unusable', () => {
    const f = fakeContext('<p>keep me</p>')
    const result = updateDocumentTool.invoke(call('update_document', { html: '  ' }), f.ctx)

    expect(result).toMatchObject({ ok: false, effects: { producedNothing: true } })
    expect(f.commits).toEqual([])
  })

  it('previews the partial html argument, cut at a complete construct', () => {
    const f = fakeContext('')
    updateDocumentTool.preview?.('{"html": "<p>Hello</p><p>wor', f.ctx)
    expect(f.previewDocument).toHaveBeenCalledWith('<p>Hello</p><p>wor')
    updateDocumentTool.preview?.('{"other": 1', f.ctx)
    expect(f.previewDocument).toHaveBeenCalledTimes(1)
  })
})

describe('edit_document arguments', () => {
  it('treats a missing replace as a deletion and drops malformed entries', () => {
    const f = fakeContext('<p>keep</p><p>drop</p>')
    const result = editDocumentTool.invoke(call('edit_document', {
      edits: [{ search: '<p>drop</p>' }, null, { replace: 'no search' }, 'text']
    }), f.ctx)

    expect(result).toMatchObject({ ok: true, trace: 'edit_document: 1/1' })
    expect(stripDiffMarkup(f.lastCommit())).toBe('<p>keep</p>')
  })

  it('turns an unusable edit list into a "produced nothing" result', () => {
    const f = fakeContext('<p>a</p>')
    const result = editDocumentTool.invoke(call('edit_document', { edits: [] }), f.ctx)

    expect(result).toMatchObject({ ok: false, effects: { producedNothing: true } })
    expect(f.commits).toEqual([])
  })
})

describe('replace_selection', () => {
  it('is offered only when there is a selection', () => {
    expect(replaceSelectionTool.isAvailable(fakeContext('').ctx)).toBe(false)
    expect(replaceSelectionTool.isAvailable(fakeContext('', { selection: { from: 1, to: 4 } }).ctx)).toBe(true)
  })

  it('writes the rewrite, commits the editor, and lets edits beside it apply locally', () => {
    const f = fakeContext('<p>sel</p><p>tail</p>', {
      editorHtml: '<p>sel</p><p>tail</p>',
      selection: { from: 1, to: 4 },
      // The rewrite replaces the first paragraph; the tail stays as it was.
      afterReplace: html => html + '<p>tail</p>'
    })
    const placed = replaceSelectionTool.invoke(call('replace_selection', { html: '<p>SEL</p>' }), f.ctx)
    expect(placed).toMatchObject({ ok: true })
    expect(f.ctx.run.selectionApplied).toBe(true)

    const beside = editDocumentTool.invoke(call('edit_document', edit('<p>tail</p>', '<p>TAIL</p>')), f.ctx)
    expect(beside).toMatchObject({ ok: true })
    expect(stripDiffMarkup(f.lastCommit())).toContain('TAIL')
  })

  it('reports a selection that is gone, and the edits beside it as not applied', () => {
    const f = fakeContext('<p>x</p>', { editorHtml: '<p>x</p>', selection: { from: 1, to: 2 }, replaceRangeResult: null })
    const placed = replaceSelectionTool.invoke(call('replace_selection', { html: '<p>y</p>' }), f.ctx)
    const beside = editDocumentTool.invoke(call('edit_document', edit('<p>x</p>', '<p>z</p>')), f.ctx)

    expect(placed).toMatchObject({ ok: false, effects: { selectionGone: true } })
    expect(beside).toMatchObject({ ok: false, effects: { failedEdits: 1 } })
    expect(f.commits).toEqual([])
  })

  it('writes nothing without an editor, silently, as before the loop', () => {
    const f = fakeContext('<p>x</p>', { selection: { from: 1, to: 2 } })
    const placed = replaceSelectionTool.invoke(call('replace_selection', { html: '<p>y</p>' }), f.ctx)

    expect(placed).toMatchObject({ ok: false })
    expect((placed as { effects?: unknown }).effects).toBeUndefined()
    expect(f.ctx.run.selectionAttempted).toBe(true)
  })
})
