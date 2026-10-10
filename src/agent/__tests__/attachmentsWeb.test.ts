/**
 * Attachments and web access (docs/features/attachments_and_web.md): the
 * tools over an attached novel — section reads, grep, analyze, the per-turn
 * cap — and the web tools on a fake browser. Mirrors
 * scripts/test_attachments_web.py.
 */
import { describe, it, expect } from 'vitest'
import { readChapterTool, grepTool, readTool as analyzeBookTool, listTool } from '../tools/bookReads'
import { ATTACHMENT_CHUNK_CHARS } from '../tools/analyzeBook'
import { planAnalysis, ANALYZE_CONFIRM_TOKENS } from '../analyzeBook'
import { webSearchTool, webReadTool } from '../tools/web'
import { ATTACHMENT_RUN_READ_CAP, attachmentParagraphs, attachmentSections, type AttachmentMeta } from '../../utils/attachments'
import { UNTRUSTED_WEB_NOTE, type WebPage, type WebSearchResult } from '../../utils/webText'
import type { ToolContext, ToolInvocation, ToolResult } from '../types'
import { fakeContext } from './fakeContext'

const call = (name: string, args: Record<string, unknown>): ToolInvocation => ({ id: `c-${name}`, name, args, source: 'native' })
const exec = async (tool: { name: string; invoke: (inv: ToolInvocation, ctx: never) => ToolResult | Promise<ToolResult> }, args: Record<string, unknown>, ctx: ToolContext) =>
  tool.invoke(call(tool.name, args), ctx as never)

const CN = '零一二三四五六七八九'
const cnNumber = (n: number) => n < 10 ? CN[n] : `${Math.floor(n / 10) === 1 ? '' : CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ''}`

/** A long novel in the shape of a downloaded .txt: headings, then indented paragraphs. */
function novel(chapters = 40, paragraphs = 50, width = 100): string {
  const out: string[] = []
  for (let c = 1; c <= chapters; c++) {
    out.push(`第${cnNumber(c)}章 第${c}回的故事`)
    for (let p = 1; p <= paragraphs; p++) out.push('　　' + (`〔${c}-${p}〕` + (p === 7 ? '林动' : '') + '字'.repeat(width)).slice(0, width))
  }
  return out.join('\n')
}

function withNovel() {
  const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '第二章', content: '<p>林动出场。</p>' }] })
  const paras = attachmentParagraphs(novel())
  const meta: AttachmentMeta = { id: 'att-1', ref: 'A1', name: '万倍返还.txt', chars: paras.reduce((n, p) => n + p.length, 0), paragraphs: paras.length, sections: attachmentSections(paras) }
  const reads: string[] = []
  f.ctx.attachments = { list: () => [meta], paragraphs: async id => { reads.push(id); return paras } }
  return { ...f, meta, reads }
}

describe('reading an attachment', () => {
  it('reads a section by its heading, in Chinese or Arabic numerals', async () => {
    const f = withNovel()
    const byChinese = await exec(readChapterTool, { chapters: ['A1'], section: '第三十章' }, f.ctx)
    expect(byChinese.ok).toBe(true)
    expect(byChinese.content).toContain('〔30-1〕')
    expect(byChinese.content).not.toContain('〔31-')
    expect(byChinese.trace.startsWith('📖 read A1 "万倍返还.txt" ¶')).toBe(true)
    const byDigits = await exec(readChapterTool, { chapters: ['附件1'], section: '第30章' }, withNovel().ctx)
    expect(byDigits.content).toBe(byChinese.content)
  })

  it('names the sections there are when one is not found, and refuses a section on a chapter', async () => {
    const f = withNovel()
    const out = await exec(readChapterTool, { chapters: ['A1'], section: '第九十九章' }, f.ctx)
    expect(out.ok).toBe(false)
    expect(out.content).toContain('has no section matching "第九十九章"')
    expect(out.content).toContain('"第一章 第1回的故事"')
    expect((await exec(readChapterTool, { chapters: ['2'], section: '第一章' }, f.ctx)).content).toContain('names a part of an attachment')
  })

  it('never reads a whole file, and caps what one turn reads', async () => {
    const f = withNovel()
    expect(f.meta.chars).toBeGreaterThan(ATTACHMENT_RUN_READ_CAP)
    let start = 1
    let out: ToolResult | undefined
    for (let i = 0; i < 20; i++) {
      out = await exec(readChapterTool, { chapters: ['A1'], paragraphs: `${start}-` }, f.ctx)
      if (!out.ok) break
      expect(out.content.length).toBeLessThan(21_000)
      const nums = out.content.split('\n').filter(l => l.startsWith('¶')).map(l => Number(l.slice(1).split(' ')[0]))
      start = Math.max(...nums) + 1
    }
    expect(f.ctx.run.attachmentChars).toBeLessThanOrEqual(ATTACHMENT_RUN_READ_CAP)
    expect(out?.ok).toBe(false)
    expect(out?.content).toContain('never read into the conversation')
    expect(out?.content).toContain('grep chapters=["A1"]')
  })

  it('greps an attachment only when it is named', async () => {
    const f = withNovel()
    const named = await exec(grepTool, { pattern: '林动', chapters: ['A1'], max_results: 3 }, f.ctx)
    expect(named.content).toContain('40 match(es) in 1 chapter(s) in 1 chapter(s); showing the first 3:')
    expect(named.content).toContain('A1 "万倍返还.txt" ¶8: ')
    expect(named.trace.startsWith('🔎 grep /林动/ in A1 → 40 matches')).toBe(true)
    const whole = await exec(grepTool, { pattern: '林动' }, f.ctx)
    expect(whole.content).not.toContain('A1')
    expect(whole.content).toContain('#2 "第二章" ¶1')
  })

  it('resolves an attachment by name, but a chapter title wins', async () => {
    const f = withNovel()
    expect((await exec(readChapterTool, { chapters: ['万倍返还.txt'], paragraphs: '1-2' }, f.ctx)).content).toContain('=== A1')
    expect((await exec(readChapterTool, { chapters: ['第二章'] }, f.ctx)).content).toContain('林动出场')
  })

  it('lets analyze_book read a whole attachment in chunks, outside the conversation', async () => {
    const f = withNovel()
    const seen: Array<{ title: string; content: string }> = []
    f.ctx.analyze = { run: async (_task, chapters) => { seen.push(...chapters); return { notes: '林动在每一章都出现。', batches: 2, total: 2, stopped: false } } }
    const out = await exec(analyzeBookTool, { task: '林动的经历', chapters: ['A1'] }, f.ctx)
    expect(out.ok).toBe(true)
    expect(out.content).toContain('林动在每一章都出现')
    expect(seen).toHaveLength(40)
    expect(seen[0].title.startsWith('A1 "万倍返还.txt" — 第一章')).toBe(true)
    expect(seen.every(c => c.content.length <= ATTACHMENT_CHUNK_CHARS)).toBe(true)
    expect(f.ctx.run.attachmentChars).toBe(0)
    expect(out.trace).toContain('A1')
  })
})

// run-737f3d809b45: analyze_book read a 2M-character attachment whole (1.58M
// tokens) for a task that needed chapters 62–87.
describe('analyze_book on part of an attachment, and what it costs', () => {
  const analyzeSpy = (plan?: (task: string, chapters: Array<{ content: string }>) => { calls: number; inputTokens: number; batchChars: number }) => {
    const seen: Array<{ title: string; content: string }> = []
    return {
      seen,
      port: {
        run: async (_task: string, chapters: Array<{ id: string; title: string; content: string }>) => { seen.push(...chapters); return { notes: '笔记。', batches: 1, total: 1, stopped: false } },
        ...(plan ? { plan } : {})
      }
    }
  }

  it('reads only the sections named, by heading or as a run', async () => {
    const f = withNovel()
    const spy = analyzeSpy()
    f.ctx.analyze = spy.port
    // Eleven sections (~55k characters): more than one read, so it is read for the task.
    const out = await exec(analyzeBookTool, { task: '第十到二十章讲了什么', chapters: ['A1'], section: '第十–二十章' }, f.ctx)
    expect(out.ok).toBe(true)
    const titles = spy.seen.map(c => c.title.split(' — ')[1].split(' (')[0])
    expect(titles[0]).toBe('第十章 第10回的故事')
    expect(titles.at(-1)).toBe('第二十章 第20回的故事')
    expect(titles).toHaveLength(11)
    expect(out.trace).toContain('A1 第十–二十章')
  })

  it('reads a ¶ range, which grep reports', async () => {
    const f = withNovel()
    const spy = analyzeSpy()
    f.ctx.analyze = spy.port
    const out = await exec(analyzeBookTool, { task: 't', chapters: ['A1'], paragraphs: '52-500' }, f.ctx)
    expect(out.ok).toBe(true)
    const text = spy.seen.map(c => c.content).join('\n')
    expect(text).toContain('〔2-1〕')
    expect(text).not.toContain('〔1-50〕')
    expect(text).not.toContain('〔11-1〕')
    expect(out.trace).toContain('A1 ¶52–500')
  })

  it('refuses a section that is not there, and a range without an attachment', async () => {
    const f = withNovel()
    f.ctx.analyze = analyzeSpy().port
    expect((await exec(analyzeBookTool, { task: 't', chapters: ['A1'], section: '第九十九章' }, f.ctx)).content).toContain('has no section matching')
    expect((await exec(analyzeBookTool, { task: 't', chapters: ['2'], section: '第一章' }, f.ctx)).content).toContain('names a part of an attachment')
  })

  it('asks first past 200,000 input tokens, and runs once the user agreed', async () => {
    const f = withNovel()
    const spy = analyzeSpy(() => ({ calls: 11, inputTokens: 1_500_000, batchChars: 140_000 }))
    f.ctx.analyze = spy.port
    const first = await exec(analyzeBookTool, { task: 't', chapters: ['A1'] }, f.ctx)
    expect(first.ok).toBe(false)
    expect(first.content).toContain('1500000 input tokens in 11 model calls')
    expect(first.content).toContain('ask_user')
    expect(first.trace).toBe('📚 read for a task: A1 ≈ 1500k tokens in 11 calls — asks first')
    expect(spy.seen).toHaveLength(0)
    const second = await exec(analyzeBookTool, { task: 't', chapters: ['A1'], confirmed: true }, f.ctx)
    expect(second.ok).toBe(true)
    expect(spy.seen.length).toBeGreaterThan(0)
  })

  it('sizes batches under grok\'s 200k price line for Chinese text', () => {
    const chapters = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, title: `第${i}章`, content: '字'.repeat(100_000) }))
    const plan = planAnalysis('t', chapters, 'grok')
    expect(plan.batchChars).toBe(140_000)
    expect(plan.calls).toBe(20)
    expect(plan.inputTokens).toBeGreaterThan(ANALYZE_CONFIRM_TOKENS)
    // One batch stays under the line even with the running notes.
    expect(plan.inputTokens / plan.calls).toBeLessThan(200_000)
  })
})

// read_and_list.md §3: an 879-chapter attachment showed 80 headings in the
// request, and the model grepped for the rest three steps in a row.
describe('list', () => {
  it('lists the chapters and then each attachment', async () => {
    const out = await exec(listTool, {}, withNovel().ctx)
    expect(out.content).toContain('2. "第二章"')
    expect(out.content).toContain('A1 "万倍返还.txt" — ')
    expect(out.content).toContain('40 sections')
    expect(out.trace).toBe('📚 list chapters and 1 attachment')
  })

  it("pages through an attachment's sections with their ¶ spans, or only the run asked for", async () => {
    const f = withNovel()
    const page = await exec(listTool, { source: 'A1', from: 39 }, f.ctx)
    expect(page.content).toContain('39. ¶1939–1989 第三十九章 第39回的故事')
    expect(page.content).toContain('40. ¶1990–2040 第四十章 第40回的故事')
    expect(page.trace).toBe('📚 list A1 sections 39–40 of 40')
    const run = await exec(listTool, { source: 'A1', section: '第十–十二章' }, f.ctx)
    expect(run.content).toContain('1. ¶460–510 第十章 第10回的故事')
    expect(run.content).toContain('3. ¶562–612 第十二章 第12回的故事')
    expect(run.content).not.toContain('第十三章')
    const byParas = await exec(listTool, { source: 'A1', paragraphs: '1-60' }, f.ctx)
    expect(byParas.trace).toBe('📚 list A1 sections 1–2 of 2')
  })

  it("lists a chapter's headings, and answers to list_chapters", async () => {
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '大纲', content: '<h1>大纲</h1><p>a</p><h2>第一卷</h2><p>b</p>' }] })
    const out = await exec(listTool, { source: '2' }, f.ctx)
    expect(out.content).toContain('¶1 # 大纲\n¶3 # 第一卷')
    expect((await exec(listTool, { source: 'A9' }, f.ctx)).ok).toBe(false)
  })
})

describe('web tools', () => {
  const fakeWeb = (fail = '') => {
    const calls: unknown[] = []
    return {
      calls,
      search: async (query: string, maxResults: number): Promise<WebSearchResult[]> => {
        calls.push(['search', query, maxResults])
        if (fail) throw new Error(fail)
        return [{ title: '万倍返还 - 百科', url: 'https://example.org/wanbei', snippet: '一部网络小说。' }]
      },
      read: async (url: string): Promise<WebPage> => {
        calls.push(['read', url])
        if (fail) throw new Error(fail)
        return { url, title: '页面', paragraphs: Array.from({ length: 30 }, (_, i) => `第${i + 1}段`) }
      }
    }
  }

  it('are offered only with a browser', () => {
    const f = withNovel()
    expect(webSearchTool.isAvailable(f.ctx)).toBe(false)
    expect(webReadTool.isAvailable(f.ctx)).toBe(false)
    f.ctx.web = fakeWeb()
    expect(webSearchTool.isAvailable(f.ctx)).toBe(true)
  })

  it('search and read render text marked as untrusted', async () => {
    const f = withNovel()
    const web = fakeWeb()
    f.ctx.web = web
    const out = await exec(webSearchTool, { query: '万倍返还 小说', max_results: 50 }, f.ctx)
    expect(out.ok).toBe(true)
    expect(out.content).toContain(UNTRUSTED_WEB_NOTE)
    expect(out.content).toContain('https://example.org/wanbei')
    expect(web.calls[0]).toEqual(['search', '万倍返还 小说', 10])
    expect(out.trace).toBe('🌐 search "万倍返还 小说" → 1 result')
    const page = await exec(webReadTool, { url: 'https://example.org/wanbei', paragraphs: '5-6' }, f.ctx)
    expect(page.ok).toBe(true)
    expect(page.content).toContain('¶5 第5段\n¶6 第6段')
    expect(page.content).not.toContain('¶7')
    expect(page.trace).toBe('🌐 read example.org ¶5–6 (0.0k)')
  })

  it('a failure reaches the model as a reason', async () => {
    const f = withNovel()
    f.ctx.web = fakeWeb('The search engine answered with a bot check; it was not bypassed.')
    const out = await exec(webSearchTool, { query: 'x' }, f.ctx)
    expect(out.ok).toBe(false)
    expect(out.retryable).toBe(false)
    expect(out.content).toContain('bot check')
  })
})
