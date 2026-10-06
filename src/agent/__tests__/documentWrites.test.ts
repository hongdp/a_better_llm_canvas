import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stripDiffMarkup, diffHtml } from '../../utils/diff'
import { updateDocumentTool, editDocumentTool, replaceSelectionTool, previewRewrite, renameChapterTool, similarChapters } from '../tools/documentWrites'
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
    expect(r.content).toContain('it had 3 characters and now has 7')
    expect(r.trace).toContain('(7 chars)')
    const e = await editDocumentTool.invoke(call('edit_document', edit('<p>六七</p>', '<p>六七八九</p>')), f.ctx)
    expect(e.content).toContain('It now has 9 characters.')
  })
})

describe('a selection rewrite while the user is in another chapter (2026-10-06)', () => {
  const book = (original: string, selected: string) => {
    const f = fakeContext(original, {
      editorHtml: '<p>THE OTHER CHAPTER</p>',
      selection: { from: 1, to: 5 },
      selectedText: selected,
      chapters: [{ id: 'doc-2', title: 'other', content: '<p>THE OTHER CHAPTER</p>' }]
    })
    f.userOpens('doc-2')
    return f
  }

  it('places it in its own chapter by its text, without nesting a paragraph', () => {
    const f = book('<p>开头。被选中的半句，后面还有。</p>', '被选中的半句')
    const r = replaceSelectionTool.invoke(call('replace_selection', { html: '<p>被选中而且扩写了的半句</p>' }), f.ctx) as ToolResult
    expect(r.ok).toBe(true)
    expect(stripDiffMarkup(f.lastWrite('doc-1') ?? '')).toBe('<p>开头。被选中而且扩写了的半句，后面还有。</p>')
    expect(f.lastWrite('doc-2')).toBeUndefined()
  })

  it('cannot place several paragraphs into part of one: reports it, and takes back a half-streamed preview', () => {
    const f = book('<p>开头。被选中的半句，后面还有。</p>', '被选中的半句')
    f.userEdits('doc-1', '<p>开头。被选中的半…（预览写了一半）</p>')
    const r = replaceSelectionTool.invoke(call('replace_selection', { html: '<p>第一段</p><p>第二段</p>' }), f.ctx) as ToolResult
    expect(r).toMatchObject({ ok: false, effects: { selectionGone: true } })
    expect(f.lastWrite('doc-1')).toBe('<p>开头。被选中的半句，后面还有。</p>')
  })

  it('edits beside it read the selection chapter\'s stored text, never the chapter on screen', () => {
    const f = book('<p>被选中的一段。</p><p>后面一句。</p>', '<p>被选中的一段。</p>')
    expect((replaceSelectionTool.invoke(call('replace_selection', { html: '<p>改写后的一段。</p>' }), f.ctx) as ToolResult).ok).toBe(true)
    const e = editDocumentTool.invoke(call('edit_document', edit('<p>后面一句。</p>', '<p>后面衔接的一句。</p>')), f.ctx) as ToolResult
    expect(e.ok).toBe(true)
    expect(stripDiffMarkup(f.lastWrite('doc-1') ?? '')).toBe('<p>改写后的一段。</p><p>后面衔接的一句。</p>')
    expect(f.lastWrite('doc-2')).toBeUndefined()
  })
})

// Creating IS writing (2026-10-06): a new chapter took two model calls —
// create_chapter, then its text — and grok planned the chapter in the first
// call's reasoning (105–158 s), which the second does not see.
describe('a new chapter is created by the write that fills it', () => {
  const book = () => fakeContext('<p>start</p>', {
    chapters: [{ id: 'doc-2', title: '大纲', content: '<p>outline</p>' }]
  })
  const write = async (f: ReturnType<typeof fakeContext>, args: Record<string, unknown>): Promise<ToolResult> =>
    updateDocumentTool.invoke(call('update_document', args), f.ctx)

  it('appends the chapter, opens it, and writes it in one call', async () => {
    const f = book()
    const r = await write(f, { new_chapter: '第一章 离乡', html: '<p>阿青走了。</p>' })
    expect(r).toMatchObject({ ok: true, trace: '➕ wrote new #3 "第一章 离乡" (5 chars)' })
    expect(r.content).toBe('Created a NEW chapter #3 "第一章 离乡" at the end of the book and wrote it (5 characters). The book now has 3 chapters.')
    const chapter = f.book()[2]
    expect(chapter.title).toBe('第一章 离乡')
    expect(stripDiffMarkup(chapter.content)).toBe('<p>阿青走了。</p>')
    expect(f.opened).toEqual([chapter.id])
    expect(f.ctx.run.touched.get(chapter.id)?.kind).toBe('created')
  })

  it('is created by the live preview on its first chunk, which then streams into it', async () => {
    const f = book()
    previewRewrite(f.ctx, { create: '第一章' }, '<p>阿青</p>')
    const id = f.book()[2]?.id
    expect(f.book()).toHaveLength(3)
    expect(f.opened).toEqual([id])
    // Not in the chunk that opened it: the editor on screen is still the
    // previous chapter's until it re-renders.
    expect(f.previewDocument).not.toHaveBeenCalled()
    previewRewrite(f.ctx, { create: '第一章' }, '<p>阿青走了</p>')
    expect(f.previewDocument).toHaveBeenLastCalledWith('<p>阿青走了</p>')
    // The write lands in the same chapter: no second one.
    expect((await write(f, { new_chapter: '第一章', html: '<p>阿青走了。</p>' })).ok).toBe(true)
    expect(f.book()).toHaveLength(3)
    expect(stripDiffMarkup(f.lastWrite(id) ?? '')).toBe('<p>阿青走了。</p>')
  })

  it('is created by a native call\'s preview once the title has arrived', async () => {
    const f = book()
    updateDocumentTool.preview?.('{"new_chapter": "第二章", "html": "<p>流', f.ctx)
    expect(f.book()[2]?.title).toBe('第二章')
    updateDocumentTool.preview?.('{"new_chapter": "第二章", "html": "<p>流水', f.ctx)
    expect(f.previewDocument).toHaveBeenLastCalledWith('<p>流水')
  })

  it('refuses a title a chapter with text already has, and creates nothing', async () => {
    const f = book()
    f.ctx.run.writeProtocol = 'markup'
    previewRewrite(f.ctx, { create: '大纲' }, '<p>x</p>')
    const r = await write(f, { new_chapter: ' 大 纲', html: '<p>new outline</p>' })
    expect(r.ok).toBe(false)
    expect(r.content).toContain('already exists as #2')
    expect(r.content).toContain('<canvas chapter="2">')
    expect(f.book()).toHaveLength(2)
    expect(f.lastWrite('doc-2')).toBeUndefined()
    expect(f.previewDocument).not.toHaveBeenCalled()
  })

  it('fills an empty chapter of that title instead of adding a second one', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '第三章 风起', content: '<p></p>' }] })
    const r = await write(f, { new_chapter: '第三章风起', html: '<p>风起了。</p>' })
    expect(r.ok).toBe(true)
    expect(f.book()).toHaveLength(2)
    expect(stripDiffMarkup(f.lastWrite('doc-2') ?? '')).toBe('<p>风起了。</p>')
    // Not the run's own: the end-of-run cleanup must never remove it.
    expect(f.ctx.run.created.has('doc-2')).toBe(false)
  })

  it('never takes a chapter whose text has not loaded for an empty one', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '第三章', content: '' }], lazy: { 'doc-2': '<p>real</p>' } })
    expect((await write(f, { new_chapter: '第三章', html: '<p>x</p>' })).ok).toBe(false)
  })

  it('leaves the view where the user put it: created, written, not opened', async () => {
    const f = book()
    f.userOpens('doc-2')
    previewRewrite(f.ctx, { create: '第一章' }, '<p>阿青</p>')
    expect(f.previewDocument).not.toHaveBeenCalled()
    expect(f.progress.at(-1)).toContain('第一章')
    expect((await write(f, { new_chapter: '第一章', html: '<p>阿青走了。</p>' })).ok).toBe(true)
    expect(f.opened).toEqual([])
  })

  it('does not move the user off a chapter with a pending selection rewrite', async () => {
    const f = fakeContext('<p>x</p>', { selection: { from: 1, to: 2 } })
    await write(f, { new_chapter: '新章', html: '<p>y</p>' })
    expect(f.opened).toEqual([])
  })
})

describe('similarChapters', () => {
  const book = [
    { id: 'a', title: '大纲' },
    { id: 'b', title: '第二章 进城' },
    { id: 'c', title: '第三章 风起云涌' },
    { id: 'd', title: '原作-第四章 夜宴' }
  ]
  it('finds the chapter a slightly different title was probably meant for', () => {
    expect(similarChapters('第二章 入城', 'new', book)).toEqual([{ number: 2, title: '第二章 进城' }])
    expect(similarChapters('第四章 夜宴', 'new', book)).toEqual([{ number: 4, title: '原作-第四章 夜宴' }])
  })
  it('never pairs different chapter numbers, however alike the rest', () => {
    // Not #3 "第三章 风起云涌" (another chapter number), only #2 (the same one).
    expect(similarChapters('第二章 风起云涌', 'new', book)).toEqual([{ number: 2, title: '第二章 进城' }])
    expect(similarChapters('第五章 别离', 'new', book)).toEqual([])
  })
})

describe('creating and rewriting answer differently (2026-10-06)', () => {
  it('a new chapter says it was ADDED, and points at a similar chapter it may have been meant for', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '第二章 进城', content: '<p>旧</p>' }] })
    const r = await updateDocumentTool.invoke(call('update_document', { new_chapter: '第二章 入城', html: '<p>新稿</p>' }), f.ctx)
    expect(r.content).toContain('Created a NEW chapter #3 "第二章 入城" at the end of the book')
    expect(r.content).toContain('The book now has 3 chapters.')
    expect(r.content).toContain('#2 "第二章 进城" has a similar title')
    expect(r.content).toContain('rename_chapter with chapter="3", title="第二章 进城" and replace=true')
  })

  it('a rewrite says it changed an EXISTING chapter, with its length before and after', async () => {
    const f = fakeContext('<p>四个字。</p>')
    const r = await updateDocumentTool.invoke(call('update_document', { html: '<p>现在有八个字了。</p>' }), f.ctx)
    expect(r.content).toBe('Rewrote the EXISTING chapter #1 "Chapter 1": it had 4 characters and now has 8. No chapter was added.')
  })
})

describe('rename_chapter', () => {
  const rename = (f: ReturnType<typeof fakeContext>, args: Record<string, unknown>) =>
    Promise.resolve(renameChapterTool.invoke(call('rename_chapter', args), f.ctx))

  it('renames, and says when the first heading still reads the old title', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '第二章 入城', content: '<h1>第二章 入城</h1><p>x</p>' }] })
    const r = await rename(f, { chapter: 2, title: '第二章 进城' })
    expect(r).toMatchObject({ ok: true, trace: '🏷 renamed #2 "第二章 入城" → "第二章 进城"' })
    expect(r.content).toContain('Its first heading still reads "第二章 入城"')
    expect(f.book()[1].title).toBe('第二章 进城')
    expect(f.ctx.run.touched.get('doc-2')?.kind).toBe('renamed')
  })

  it('refuses a title another chapter has, and offers the replacement only for a chapter it created', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '第二章 进城', content: '<p>旧</p>' }, { id: 'doc-3', title: '别的', content: '<p>y</p>' }] })
    const theirs = await rename(f, { chapter: 3, title: '第二章进城' })
    expect(theirs).toMatchObject({ ok: false })
    expect(theirs.content).toContain('Choose another title')
    await updateDocumentTool.invoke(call('update_document', { new_chapter: '第二章 入城', html: '<p>新稿</p>' }), f.ctx)
    const mine = await rename(f, { chapter: 4, title: '第二章 进城' })
    expect(mine.content).toContain('call rename_chapter again with replace=true')
    expect(f.book().map(c => c.title)).toEqual(['Chapter 1', '第二章 进城', '别的', '第二章 入城'])
  })

  it('with replace=true, moves the created chapter\'s text into the original — in place, reviewable — and removes it', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [
      { id: 'doc-2', title: '第二章 进城', content: '<h1>第二章 进城</h1><p>旧稿。</p>' },
      { id: 'doc-3', title: '第三章', content: '<p>三</p>' }
    ] })
    await updateDocumentTool.invoke(call('update_document', { new_chapter: '第二章 入城', html: '<h1>第二章 入城</h1><p>新稿，长一些。</p>' }), f.ctx)
    const created = f.book()[3].id
    expect(f.ctx.document.openId()).toBe(created)

    const r = await rename(f, { chapter: '第二章 入城', title: '第二章 进城', replace: true })
    expect(r.ok).toBe(true)
    expect(r.content).toContain('#2 "第二章 进城" now has the text of #4 "第二章 入城"')
    // The original keeps its place, its id and its title; the text arrives as
    // a diff against what it had, with a snapshot before it.
    expect(f.book().map(c => c.title)).toEqual(['Chapter 1', '第二章 进城', '第三章'])
    const ch2 = f.lastWrite('doc-2') ?? ''
    expect(stripDiffMarkup(ch2)).toBe('<h1>第二章 进城</h1><p>新稿，长一些。</p>')
    expect(ch2).toContain('diff-addition')
    expect(f.snapshots).toEqual(['doc-2'])
    expect(f.removed).toEqual([created])
    expect(f.ctx.document.openId()).toBe('doc-2')
    expect([...f.ctx.run.touched.values()].map(t => [t.documentId, t.kind])).toEqual([['doc-2', 'rewrite']])
  })

  it('never lets a chapter the run did not create take another\'s place', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '甲', content: '<p>a</p>' }, { id: 'doc-3', title: '乙', content: '<p>b</p>' }] })
    const r = await rename(f, { chapter: 3, title: '甲', replace: true })
    expect(r).toMatchObject({ ok: false, retryable: false })
    expect(f.removed).toEqual([])
    expect(f.lastWrite('doc-2')).toBeUndefined()
  })
})
