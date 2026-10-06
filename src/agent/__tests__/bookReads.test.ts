import { describe, it, expect } from 'vitest'
import { readChapterTool, grepTool, openChapterTool, createChapterTool, listChaptersTool } from '../tools/bookReads'
import type { ToolInvocation, ToolResult } from '../types'
import { fakeContext } from './fakeContext'
import { resolveChapter } from '../chapters'

const call = (name: string, args: Record<string, unknown> | null): ToolInvocation => ({ id: `c-${name}`, name, args, source: 'native' })
const run = async (r: ToolResult | Promise<ToolResult>) => r

const book = () => fakeContext('<p>start</p>', {
  chapters: [
    { id: 'doc-2', title: '人物表', content: '<p>主角：阿青。</p>' },
    { id: 'doc-3', title: '故事线', content: '<p>大纲：第一章，阿青离开村子。</p>', summary: '全书分章计划' }
  ]
})

describe('resolveChapter', () => {
  const chapters = [{ id: 'a', title: '序章' }, { id: 'b', title: '第一章 离乡' }, { id: 'c', title: '第一章 番外' }]
  it('takes numbers, numeric strings and exact titles', () => {
    expect(resolveChapter(2, chapters)).toMatchObject({ id: 'b', number: 2 })
    expect(resolveChapter('#3', chapters)).toMatchObject({ id: 'c' })
    expect(resolveChapter('序章', chapters)).toMatchObject({ id: 'a' })
  })
  it('takes a unique partial title, and lists candidates for an ambiguous one', () => {
    expect(resolveChapter('离乡', chapters)).toMatchObject({ id: 'b' })
    expect(resolveChapter('第一章', chapters)).toContain('matches 2 chapters')
  })
  it('explains a reference that names nothing', () => {
    expect(resolveChapter(9, chapters)).toContain('the book has 3 chapters')
    expect(resolveChapter('终章', chapters)).toContain('1. "序章"')
  })
})

describe('read_chapter', () => {
  it('reads several chapters as text, and marks only html reads as seen for editing', async () => {
    const f = book()
    const r = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2, '故事线'] }), f.ctx))
    expect(r.ok).toBe(true)
    expect(r.content).toContain('=== #2 "人物表"')
    expect(r.content).toContain('阿青离开村子')
    expect(r.content).not.toContain('<p>')
    expect(f.ctx.run.htmlShown.has('doc-3')).toBe(false)
    expect([...f.ctx.run.readIds]).toEqual(['doc-2', 'doc-3'])

    await run(readChapterTool.invoke(call('read_chapter', { chapters: [3], format: 'html' }), f.ctx))
    expect(f.ctx.run.htmlShown.has('doc-3')).toBe(true)
  })

  it('loads a lazy chapter before reading it', async () => {
    const f = fakeContext('<p>start</p>', {
      chapters: [{ id: 'doc-2', title: 'Lazy', content: '' }],
      lazy: { 'doc-2': '<p>loaded text</p>' }
    })
    const r = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2] }), f.ctx))
    expect(f.ensureLoaded).toHaveBeenCalledWith(['doc-2'])
    expect(r.content).toContain('loaded text')
  })

  it('pages a long chapter at whole paragraphs and names the range to continue from', async () => {
    const paras = Array.from({ length: 30 }, (_, i) => `<p>${String(i + 1).padStart(2, '0')}${'x'.repeat(1000)}</p>`).join('')
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: 'Long', content: paras }] })
    const first = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2] }), f.ctx))
    const stop = /Stopped at ¶(\d+)/.exec(first.content)
    expect(stop).not.toBeNull()
    const last = Number(stop?.[1])
    expect(first.content).toContain(`paragraphs="${last + 1}-"`)
    // Never mid-paragraph: the last line returned is a whole one.
    expect(first.content).toContain(`¶${last} ${String(last).padStart(2, '0')}${'x'.repeat(1000)}`)
    const rest = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], paragraphs: `${last + 1}-` }), f.ctx))
    expect(rest.content).toContain('¶30 30')
    expect(rest.content).not.toContain('Stopped at')
  })

  it('numbers paragraphs in text, marks headings and images, and leaves html unnumbered', async () => {
    const f = fakeContext('<p>start</p>', {
      chapters: [{ id: 'doc-2', title: 'C', content: '<h2>第二章</h2><p>甲。</p><p><img src="a.png"></p><p>乙。</p>' }]
    })
    const text = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2] }), f.ctx))
    expect(text.content).toContain('¶1 # 第二章\n¶2 甲。\n¶3 [image]\n¶4 乙。')
    const html = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], format: 'html' }), f.ctx))
    expect(html.content).toContain('<h2>第二章</h2>\n<p>甲。</p>')
    expect(html.content).not.toContain('¶')
  })

  it('reads only the paragraphs asked for — the way to look around a grep hit', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: 'C', content: '<p>一。</p><p>二。</p><p>三。</p><p>四。</p>' }] })
    const r = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], paragraphs: '2-3' }), f.ctx))
    expect(r.content).toContain('4 paragraphs')
    expect(r.content).toContain('¶2–¶3 of 4')
    expect(r.content).toContain('¶2 二。\n¶3 三。')
    expect(r.content).not.toContain('¶1 ')
    expect(r.content).not.toContain('¶4 ')
    // A range read is not refused as "already in context".
    f.ctx.run.inContext.add('doc-2')
    const again = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], paragraphs: '4' }), f.ctx))
    expect(again.content).toContain('¶4 四。')
  })

  it('explains a range it cannot read', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: 'C', content: '<p>一。</p>' }] })
    const bad = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], paragraphs: 'middle' }), f.ctx))
    expect(bad.content).toContain('"40-60"')
    const past = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], paragraphs: '9-12' }), f.ctx))
    expect(past.content).toContain('has 1 paragraphs; there is no ¶9')
  })

  it('does not resend a chapter already in the request, nor one already returned this run', async () => {
    const f = fakeContext('<p>start</p>', {
      chapters: [{ id: 'doc-2', title: 'Ledger', content: '<p>a</p>' }, { id: 'doc-3', title: 'Other', content: '<p>b</p>' }],
      inContext: ['doc-2']
    })
    const inRequest = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2] }), f.ctx))
    expect(inRequest.content).toContain('already in your context')

    await run(readChapterTool.invoke(call('read_chapter', { chapters: [3] }), f.ctx))
    f.ctx.run.step = 1
    const repeat = await run(readChapterTool.invoke(call('read_chapter', { chapters: [3] }), f.ctx))
    expect(repeat.content).toContain('already returned in step 1')
  })

  it('reads back the run\'s own changes, not the stored copy', async () => {
    const f = book()
    f.ctx.run.docs.set('doc-2', { original: '<p>主角：阿青。</p>', base: '<p>主角：阿青。</p>', reviewBase: '<p>主角：阿青。</p>', html: '<p>主角：阿红。</p>', dirty: true })
    const r = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2] }), f.ctx))
    expect(r.content).toContain('阿红')
  })

  it('reports a reference that names nothing, as a retryable error', async () => {
    const r = await run(readChapterTool.invoke(call('read_chapter', { chapters: [9] }), book().ctx))
    expect(r).toMatchObject({ ok: false, retryable: true })
  })
})

describe('grep', () => {
  it('finds a regex across chapters, titles included, with chapter and paragraph numbers', async () => {
    const r = await run(grepTool.invoke(call('grep', { pattern: '大纲|人物' }), book().ctx))
    expect(r.content).toContain('#3 "故事线" ¶1: 大纲')
    expect(r.content).toContain('#2 "人物表" (title matches)')
  })

  it('uses real regular expressions', async () => {
    const r = await run(grepTool.invoke(call('grep', { pattern: '阿[青红]', output: 'chapters' }), book().ctx))
    expect(r.content).toContain('#2 "人物表" — 1 match')
    expect(r.content).toContain('#3 "故事线" — 1 match')
  })

  it('searches only the chapters named', async () => {
    const r = await run(grepTool.invoke(call('grep', { pattern: '阿青', chapters: [3] }), book().ctx))
    expect(r.content).toContain('#3 "故事线"')
    expect(r.content).not.toContain('#2')
  })

  it('searches a broken regex as plain text, and says so', async () => {
    const f = fakeContext('<p>a (b</p>')
    const r = await run(grepTool.invoke(call('grep', { pattern: '(b' }), f.ctx))
    expect(r.content).toContain('searched as plain text')
    expect(r.content).toContain('#1 "Chapter 1" ¶1: a (b')
  })

  it('loads lazy chapters before searching them', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: 'Lazy', content: '' }], lazy: { 'doc-2': '<p>hidden word</p>' } })
    const r = await run(grepTool.invoke(call('grep', { pattern: 'hidden' }), f.ctx))
    expect(r.content).toContain('#2 "Lazy"')
  })

  it('stops at a zero-width match instead of looping', async () => {
    const r = await run(grepTool.invoke(call('grep', { pattern: 'x*' }), fakeContext('<p>abc</p>').ctx))
    expect(r.content).toContain('No matches')
  })
})

describe('list_chapters', () => {
  it('lists every chapter with what this run did to it', async () => {
    const f = book()
    f.ctx.run.touched.set('doc-2', { documentId: 'doc-2', titleAtRun: '人物表', kind: 'edits', changes: 1, failed: 0 })
    const r = await run(listChaptersTool.invoke(call('list_chapters', {}), f.ctx))
    expect(r.content).toContain('1. "Chapter 1"')
    expect(r.content).toContain('open in the editor')
    expect(r.content).toContain('changed this turn')
    expect(r.content).toContain('全书分章计划')
  })
})

describe('open_chapter', () => {
  it('shows a chapter, and says its text is not in context', async () => {
    const f = book()
    const r = await run(openChapterTool.invoke(call('open_chapter', { chapter: 3 }), f.ctx))
    expect(f.opened).toEqual(['doc-3'])
    expect(r.content).toContain('not in your context')
  })

  it('refuses to leave a pending selection behind', async () => {
    const f = fakeContext('<p>x</p>', { selection: { from: 1, to: 2 }, chapters: [{ id: 'doc-2', title: 'B', content: '<p>b</p>' }] })
    const r = await run(openChapterTool.invoke(call('open_chapter', { chapter: 2 }), f.ctx))
    expect(r).toMatchObject({ ok: false, retryable: false })
    expect(f.opened).toEqual([])
  })
})

describe('create_chapter', () => {
  it('appends an empty chapter without opening it, ready to write', async () => {
    const f = book()
    const r = await run(createChapterTool.invoke(call('create_chapter', { title: '第一章 离乡' }), f.ctx))
    expect(r.content).toContain('#4 "第一章 离乡"')
    expect(f.opened).toEqual([])
    const id = f.book()[3].id
    expect(f.ctx.run.created.has(id)).toBe(true)
    expect(f.ctx.run.htmlShown.has(id)).toBe(true)
  })

  it('refuses a duplicate title and points at the existing chapter', async () => {
    const r = await run(createChapterTool.invoke(call('create_chapter', { title: '故事线' }), book().ctx))
    expect(r).toMatchObject({ ok: false })
    expect(r.content).toContain('#3')
  })
})
