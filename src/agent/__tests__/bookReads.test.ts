import { describe, it, expect } from 'vitest'
import { readChapterTool, grepTool, openChapterTool, listChaptersTool, deleteChapterTool } from '../tools/bookReads'
import { updateDocumentTool } from '../tools/documentWrites'
import type { ToolInvocation, ToolResult } from '../types'
import { fakeContext } from './fakeContext'
import { resolveChapter } from '../chapters'
import { chapterOutline } from '../types'

const call = (name: string, args: Record<string, unknown> | null): ToolInvocation => ({ id: `c-${name}`, name, args, source: 'native' })
const run = async (r: ToolResult | Promise<ToolResult>) => r

const book = () => fakeContext('<p>start</p>', {
  chapters: [
    { id: 'doc-2', title: '人物表', content: '<p>主角：阿青。</p>' },
    { id: 'doc-3', title: '故事线', content: '<p>大纲：第一章，阿青离开村子。</p>' }
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

  it('reads a range that arrives wrapped in an extra pair of quotes (grok, 2026-10-06)', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: 'x', content: '<p>一</p><p>二</p><p>三</p>' }] })
    const r = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], paragraphs: '"2-3"' }), f.ctx))
    expect(r.ok).toBe(true)
    expect(r.content).toContain('¶2–¶3 of 3')
  })

  it('reads "-2" as the first two paragraphs, quoted or not (grok asked this way and was refused, 2026-10-06)', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: 'x', content: '<p>一</p><p>二</p><p>三</p>' }] })
    const r = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], paragraphs: '"-2"' }), f.ctx))
    expect(r.ok).toBe(true)
    expect(r.content).toContain('¶1–¶2 of 3')
    expect(r.content).not.toContain('¶3 三')
    const zero = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], paragraphs: '-0' }), f.ctx))
    expect(zero.ok).toBe(false)
  })

  it('states the size of a paragraph range, so a length can be planned from a number, not a guess', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '原文', content: '<p>一二三</p><p>四五六七</p><p>八九</p>' }] })
    const r = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2], paragraphs: '2-3' }), f.ctx))
    expect(r.content).toContain('3 paragraphs, 9 characters, ¶2–¶3 of 3 (6 characters), text')
  })

  it('lets the model read again what it read, or was sent, several steps back (its call, user decision 2026-10-06)', async () => {
    const f = fakeContext('<p>start</p>', {
      chapters: [{ id: 'doc-2', title: 'Ledger', content: '<p>outline</p>' }, { id: 'doc-3', title: 'Other', content: '<p>source</p>' }],
      inContext: ['doc-2']
    })
    await run(readChapterTool.invoke(call('read_chapter', { chapters: [3] }), f.ctx))
    // Many chapters later in a long series:
    f.ctx.run.step = 9
    const again = await run(readChapterTool.invoke(call('read_chapter', { chapters: [3] }), f.ctx))
    expect(again.content).toContain('source')
    const inRequest = await run(readChapterTool.invoke(call('read_chapter', { chapters: [2] }), f.ctx))
    expect(inRequest.content).toContain('outline')
    expect(inRequest.content).not.toContain('already in your context')
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

  it('names what it searched in the trace: the whole book, or the chapters given', async () => {
    const whole = await run(grepTool.invoke(call('grep', { pattern: '阿[青红]' }), book().ctx))
    expect(whole.trace).toBe('🔎 grep /阿[青红]/ in the whole book → 2 matches in 2 chapter(s)')
    const one = await run(grepTool.invoke(call('grep', { pattern: '阿青', chapters: [3] }), book().ctx))
    expect(one.trace).toBe('🔎 grep /阿青/ in #3 → 1 match')
  })

  it('says which chapters it could not load, instead of reporting no match in them', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: 'Lazy', content: '' }], lazy: { 'doc-2': '<p>hidden word</p>' } })
    f.ensureLoaded.mockImplementation(async () => {})
    const r = await run(grepTool.invoke(call('grep', { pattern: 'hidden' }), f.ctx))
    expect(r.content).toContain('Not searched — their text could not be loaded: #2 "Lazy"')
    expect(r.trace).toContain('1 not loaded')
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
    expect(r.content).toContain('3. "故事线" (1 paragraphs')
  })

  // 2026-10-06: grok announced "人物卡单独成章" and called this 13 times; the
  // list was right every time and never said that nothing had been added.
  it('says when no chapter was added, removed or renamed in this turn, and how one is added', async () => {
    const f = book()
    f.ctx.run.writeProtocol = 'markup'
    f.ctx.run.startOutline = chapterOutline(f.ctx.document.chapters())
    const r = await run(listChaptersTool.invoke(call('list_chapters', {}), f.ctx))
    expect(r.content).toContain('No chapter has been added, removed or renamed in this turn')
    expect(r.content).toContain('A new chapter appears here only after you write it, with <canvas new_chapter="its title">…</canvas>.')
    expect(r.content).not.toContain('identical to your previous')
  })

  it('says when the list is identical to the last one', async () => {
    const f = book()
    await run(listChaptersTool.invoke(call('list_chapters', {}), f.ctx))
    const again = await run(listChaptersTool.invoke(call('list_chapters', {}), f.ctx))
    expect(again.content).toContain('This is identical to your previous list result')
  })

  it('makes no such claim once the book changed in the turn', async () => {
    const f = book()
    f.ctx.run.startOutline = chapterOutline(f.ctx.document.chapters())
    await run(listChaptersTool.invoke(call('list_chapters', {}), f.ctx))
    await updateDocumentTool.invoke(call('update_document', { new_chapter: '人物卡', html: '<p>阿青</p>' }), f.ctx)
    const r = await run(listChaptersTool.invoke(call('list_chapters', {}), f.ctx))
    expect(r.content).toContain('"人物卡"')
    expect(r.content).toContain('created this turn')
    expect(r.content).not.toContain('No chapter has been added')
    expect(r.content).not.toContain('identical to your previous')
  })
})

describe('open_chapter', () => {
  it('shows a chapter, and tells the model a rewrite needs no further step', async () => {
    // Measured: the old "read it with format html before editing it" made the
    // model open, open again, then rewrite — two wasted steps.
    const f = book()
    f.ctx.run.writeProtocol = 'markup'
    const r = await run(openChapterTool.invoke(call('open_chapter', { chapter: 3 }), f.ctx))
    expect(f.opened).toEqual(['doc-3'])
    expect(r.content).toContain('write it now: <canvas chapter="3">')
    expect(r.content).toContain('Only edits to parts of it need its HTML first')
  })

  it('names the write in the form the model uses, and does not reopen an open chapter', async () => {
    const f = book()
    f.ctx.run.writeProtocol = 'tools'
    const r = await run(openChapterTool.invoke(call('open_chapter', { chapter: 3 }), f.ctx))
    expect(r.content).toContain('update_document with chapter="3"')
    expect(r.content).not.toContain('<canvas')
    const again = await run(openChapterTool.invoke(call('open_chapter', { chapter: 3 }), f.ctx))
    expect(again.content).toContain('already open')
    expect(f.opened).toEqual(['doc-3'])
  })

  it('refuses to leave a pending selection behind', async () => {
    const f = fakeContext('<p>x</p>', { selection: { from: 1, to: 2 }, chapters: [{ id: 'doc-2', title: 'B', content: '<p>b</p>' }] })
    const r = await run(openChapterTool.invoke(call('open_chapter', { chapter: 2 }), f.ctx))
    expect(r).toMatchObject({ ok: false, retryable: false })
    expect(f.opened).toEqual([])
  })
})

describe('once the user has opened another chapter, the view is theirs', () => {
  const book = () => fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '第二章', content: '<p>two</p>' }] })

  it('open_chapter leaves the view where the user put it, and says so', () => {
    const f = book()
    f.userOpens('doc-2')
    const r = openChapterTool.invoke(call('open_chapter', { chapter: 1 }), f.ctx) as ToolResult
    expect(r).toMatchObject({ ok: true })
    expect(r.content).toContain('NOT opened')
    expect(f.opened).toEqual([])
  })

  it('a read of a chapter the user changed returns what is stored now, not the run\'s stale copy', async () => {
    const f = book()
    await readChapterTool.invoke(call('read_chapter', { chapters: [2], format: 'html' }), f.ctx)
    f.userEdits('doc-2', '<p>two, edited</p>')
    const r = await readChapterTool.invoke(call('read_chapter', { chapters: [2], format: 'html' }), f.ctx)
    expect(r.content).toContain('two, edited')
    expect(f.ctx.run.known.get('doc-2')).toBe('<p>two, edited</p>')
  })
})

describe('delete_chapter: only what nothing would be lost from', () => {
  const del = (f: ReturnType<typeof fakeContext>, chapter: unknown) =>
    run(deleteChapterTool.invoke(call('delete_chapter', { chapter }), f.ctx))
  const book = () => fakeContext('<p>start</p>', {
    chapters: [
      { id: 'doc-2', title: '大纲', content: '<p>outline</p>' },
      { id: 'doc-3', title: 'skip', content: '<p></p>' },
      { id: 'doc-4', title: '第一章', content: '<p>text</p>' }
    ]
  })

  it('deletes an empty chapter, and tells the model the chapters after it moved up', async () => {
    const f = book()
    const r = await del(f, 3)
    expect(r).toMatchObject({ ok: true, trace: '🗑 deleted #3 "skip"' })
    expect(r.content).toContain('#4 is now #3')
    expect(f.removed).toEqual(['doc-3'])
  })

  it('deletes a chapter this run created, text and all, and drops its "changed this turn" row', async () => {
    const f = book()
    await run(updateDocumentTool.invoke(call('update_document', { new_chapter: '重复的一章', html: '<p>the run wrote this</p>' }), f.ctx))
    const id = [...f.ctx.run.created][0]
    const r = await del(f, '重复的一章')
    expect(r.ok).toBe(true)
    expect(f.removed).toEqual([id])
    expect(f.ctx.run.touched.has(id)).toBe(false)
    expect(r.content).not.toContain('moved up')
  })

  it('refuses a chapter with text, which only the user may delete', async () => {
    const f = book()
    const r = await del(f, 2)
    expect(r).toMatchObject({ ok: false, retryable: false })
    expect(r.content).toContain('ask them with ask_user')
    expect(f.removed).toEqual([])
  })

  it('refuses a chapter it created once the user has typed into it', async () => {
    const f = book()
    await run(updateDocumentTool.invoke(call('update_document', { new_chapter: '新章', html: '<p>the run wrote this</p>' }), f.ctx))
    const id = [...f.ctx.run.created][0]
    f.userEdits(id, '<p>the user started writing here</p>')
    expect((await del(f, '新章')).ok).toBe(false)
    expect(f.removed).toEqual([])
  })

  it('refuses the chapter the turn started on', async () => {
    const f = fakeContext('<p></p>', { chapters: [{ id: 'doc-2', title: 'b', content: '<p>x</p>' }] })
    expect((await del(f, 1)).ok).toBe(false)
  })

  it('never takes a chapter whose text has not loaded for an empty one', async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: 'lazy', content: '' }], lazy: { 'doc-2': '<p>real text</p>' } })
    // The fetch fails: the chapter stays unloaded and reads as ''.
    f.ensureLoaded.mockImplementation(async () => {})
    const r = await del(f, 2)
    expect(r.ok).toBe(false)
    expect(r.content).toContain('could not be loaded')
    expect(f.removed).toEqual([])
    // Loaded, it has text: refused for that.
    f.ensureLoaded.mockRestore()
    const g = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: 'lazy', content: '' }], lazy: { 'doc-2': '<p>real text</p>' } })
    expect((await del(g, 2)).content).toContain('has text')
  })
})
