import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stripDiffMarkup, diffHtml } from '../../utils/diff'
import { updateDocumentTool, editDocumentTool, replaceSelectionTool } from '../tools/documentWrites'
import { readChapterTool } from '../tools/bookReads'
import type { ToolInvocation, ToolResult } from '../types'
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

    expect(result).toMatchObject({ ok: true, trace: '✏️ edited #1 "Chapter 1" (1 change)' })
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

describe('writes to another chapter (D2)', () => {
  const twoChapters = () => fakeContext('<p>start</p>', {
    chapters: [{ id: 'doc-2', title: '故事线', content: '<p>outline</p>' }]
  })

  it('refuses an edit on a chapter whose HTML the model has not seen, as retryable', async () => {
    const f = twoChapters()
    const r = await editDocumentTool.invoke(call('edit_document', { chapter: '2', ...edit('<p>outline</p>', '<p>x</p>') }), f.ctx)
    expect(r).toMatchObject({ ok: false, retryable: true })
    expect(r.content).toContain('read_chapter')
    expect(f.writes).toEqual([])
  })

  it('edits it once seen: diffed against its own accepted reading, snapshotted first', async () => {
    const f = twoChapters()
    f.ctx.run.htmlShown.add('doc-2')
    const r = await editDocumentTool.invoke(call('edit_document', { chapter: 2, ...edit('<p>outline</p>', '<p>OUTLINE</p>') }), f.ctx)
    expect(r).toMatchObject({ ok: true })
    expect(stripDiffMarkup(f.lastWrite('doc-2') ?? '')).toBe('<p>OUTLINE</p>')
    expect(f.snapshots).toEqual(['doc-2'])
    expect(f.commits).toEqual([])
    expect(f.ctx.run.touched.get('doc-2')).toMatchObject({ kind: 'edits', changes: 1 })
  })

  it('loads a lazy chapter before writing it, and never blanks it from an empty base', async () => {
    const f = fakeContext('<p>start</p>', {
      chapters: [{ id: 'doc-2', title: 'Lazy', content: '' }],
      lazy: { 'doc-2': '<p>real text</p>' }
    })
    f.ctx.run.htmlShown.add('doc-2')
    await editDocumentTool.invoke(call('edit_document', { chapter: 2, ...edit('<p>real text</p>', '<p>new text</p>') }), f.ctx)
    expect(f.ensureLoaded).toHaveBeenCalledWith(['doc-2'])
    expect(stripDiffMarkup(f.lastWrite('doc-2') ?? '')).toBe('<p>new text</p>')
  })

  it('rewrites a chapter created this run without a read, opening it first (D6)', async () => {
    const f = twoChapters()
    const id = f.ctx.document.create('第一章')
    f.ctx.run.created.add(id)
    f.ctx.run.htmlShown.add(id)
    const r = await updateDocumentTool.invoke(call('update_document', { chapter: '3', html: '<p>第一章正文</p>' }), f.ctx)
    expect(r).toMatchObject({ ok: true })
    expect(f.opened).toEqual([id])
    expect(f.snapshots).toEqual([])
    expect(f.ctx.run.touched.get(id)).toMatchObject({ kind: 'created' })
  })

  it('routes a rewrite preview: another chapter shows progress, never the editor', () => {
    const f = twoChapters()
    updateDocumentTool.preview?.('{"chapter": "2", "html": "<p>new outline', f.ctx)
    expect(f.previewDocument).not.toHaveBeenCalled()
    expect(f.progress.at(-1)).toContain('#2 "故事线"')
  })

  it('takes back a preview painted before the target was known', async () => {
    const f = twoChapters()
    f.ctx.run.htmlShown.add('doc-2')
    // `html` arrived before `chapter`, so the preview assumed the open chapter…
    updateDocumentTool.preview?.('{"html": "<p>new outline', f.ctx)
    expect(f.previewDocument).toHaveBeenCalled()
    // …and the call turned out to target chapter 2.
    await updateDocumentTool.invoke(call('update_document', { html: '<p>new outline</p>', chapter: 2 }), f.ctx)
    expect(f.discardPreview).toHaveBeenCalled()
    expect(stripDiffMarkup(f.lastWrite('doc-2') ?? '')).toBe('<p>new outline</p>')
  })

  it('names a chapter that does not exist as a retryable error', async () => {
    const r = await updateDocumentTool.invoke(call('update_document', { chapter: 9, html: '<p>x</p>' }), twoChapters().ctx)
    expect(r).toMatchObject({ ok: false, retryable: true })
  })
})

describe('previewing a chapter created in the same reply', () => {
  it('shows progress while the chapter does not exist yet, instead of nothing', () => {
    const f = fakeContext('<p>start</p>')
    updateDocumentTool.preview?.('{"chapter": "第五章 新的一天", "html": "<p>清晨', f.ctx)
    expect(f.previewDocument).not.toHaveBeenCalled()
    expect(f.progress.at(-1)).toContain('✍️ "第五章 新的一天"')
  })
})

describe('the user edits other chapters while the run works (§0.4)', () => {
  const book = () => fakeContext('<p>start</p>', {
    chapters: [{ id: 'doc-2', title: '人物表', content: '<p>阿青</p><p>阿红</p>' }]
  })
  const readHtml = (f: ReturnType<typeof book>, chapter: number) =>
    readChapterTool.invoke({ id: 'r', name: 'read_chapter', args: { chapters: [chapter], format: 'html' }, source: 'native' }, f.ctx)

  it('refuses an edit built on a copy the user changed since, and applies it after a fresh read — keeping their edit', async () => {
    const f = book()
    await readHtml(f, 2)
    // The user types into chapter 2 while the model is still writing.
    f.userEdits('doc-2', '<p>阿青（用户补的）</p><p>阿红</p>')

    const refused = await editDocumentTool.invoke(call('edit_document', { chapter: 2, ...edit('<p>阿红</p>', '<p>阿紫</p>') }), f.ctx)
    expect(refused).toMatchObject({ ok: false, retryable: true })
    expect(refused.content).toContain('The user edited #2')
    expect(f.writes).toEqual([])
    // The model's copy is forgotten: it must read again before editing.
    expect(f.ctx.run.htmlShown.has('doc-2')).toBe(false)

    await readHtml(f, 2)
    const applied = await editDocumentTool.invoke(call('edit_document', { chapter: 2, ...edit('<p>阿红</p>', '<p>阿紫</p>') }), f.ctx)
    expect(applied.ok).toBe(true)
    expect(stripDiffMarkup(f.lastWrite('doc-2') ?? '')).toBe('<p>阿青（用户补的）</p><p>阿紫</p>')
  })

  it('refuses a rewrite of the start chapter the user changed (no selection: it is editable mid-run)', () => {
    const f = fakeContext('<p>alpha</p>')
    f.userEdits('doc-1', '<p>alpha, edited by the user</p>')
    const r = updateDocumentTool.invoke(call('update_document', { html: '<p>beta</p>' }), f.ctx) as ToolResult
    expect(r).toMatchObject({ ok: false, retryable: true })
    expect(f.writes).toEqual([])
  })

  it('never takes the run\'s own writes for user edits', async () => {
    const f = book()
    await readHtml(f, 2)
    for (const [a, b] of [['<p>阿红</p>', '<p>阿紫</p>'], ['<p>阿紫</p>', '<p>阿蓝</p>']]) {
      expect((await editDocumentTool.invoke(call('edit_document', { chapter: 2, ...edit(a, b) }), f.ctx)).ok).toBe(true)
    }
    expect(stripDiffMarkup(f.lastWrite('doc-2') ?? '')).toBe('<p>阿青</p><p>阿蓝</p>')
  })

  it('does not check the start chapter of a selection turn, which its selection preview writes', () => {
    const f = fakeContext('<p>alpha</p>', { selectedText: 'alpha' })
    f.userEdits('doc-1', '<p>alp</p>') // a half-streamed selection preview, as stored
    const r = updateDocumentTool.invoke(call('update_document', { html: '<p>beta</p>' }), f.ctx) as ToolResult
    expect(r.ok).toBe(true)
  })

  it('does not paint a rewrite over a chapter the user changed, and does not open a created one after they moved', () => {
    const f = book()
    f.userEdits('doc-1', '<p>start, edited</p>')
    updateDocumentTool.preview?.('{"html": "<p>new', f.ctx)
    expect(f.previewDocument).not.toHaveBeenCalled()
    expect(f.progress.at(-1)).toContain('✍️')

    const g = book()
    const id = g.ctx.document.create('第一章')
    g.ctx.run.created.add(id)
    g.userOpens('doc-2')
    updateDocumentTool.preview?.('{"chapter": 3, "html": "<p>new', g.ctx)
    expect(g.opened).toEqual([])
    expect(g.ctx.document.openId()).toBe('doc-2')
  })
})

describe('write results state the chapter\'s length (counted like a read)', () => {
  it('after a rewrite and after edits', async () => {
    const f = fakeContext('<p>一二三</p>')
    const r = updateDocumentTool.invoke(call('update_document', { html: '<p>一二三四五</p><p>六七</p>' }), f.ctx) as ToolResult
    expect(r.content).toContain('was rewritten (7 characters)')
    expect(r.trace).toContain('(7 chars)')
    const e = await editDocumentTool.invoke(call('edit_document', edit('<p>六七</p>', '<p>六七八九</p>')), f.ctx)
    expect(e.content).toContain('It now has 9 characters.')
  })
})
