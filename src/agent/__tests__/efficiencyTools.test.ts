/**
 * Tools that save steps (agentic_chat_loop.md §0.11): several look-ups in one
 * call, rewrites of plain chapters from their text, edits by ¶ number, and
 * plan items marked by the write that finishes them.
 */
import { describe, it, expect } from 'vitest'
import { stripDiffMarkup } from '../../utils/diff'
import { readChapterTool, grepTool } from '../tools/bookReads'
import { updateDocumentTool, editParagraphsTool } from '../tools/documentWrites'
import { planTool } from '../tools/plan'
import { collectStep, planDoneAttributes } from '../invocations'
import { ToolRegistry } from '../registry'
import { DOCUMENT_WRITE_TOOLS } from '../tools/documentWrites'
import type { ToolInvocation, ToolResult } from '../types'
import { fakeContext } from './fakeContext'

const call = (name: string, args: Record<string, unknown> | null): ToolInvocation => ({ id: `c-${name}`, name, args, source: 'native' })
const run = async (r: ToolResult | Promise<ToolResult>) => r
const exec = (tool: { invoke: (inv: ToolInvocation, ctx: never) => ToolResult | Promise<ToolResult> }, args: Record<string, unknown>, ctx: unknown) =>
  run(tool.invoke(call((tool as unknown as { name: string }).name, args), ctx as never))

const PLAIN = '<h1>第二章</h1><p>阿青推开门。</p><p>屋里没有人。</p><p>她坐了下来。</p>'
const FORMATTED = '<p>阿青推开<em>门</em>。</p><p>屋里没有人。</p>'
const book = () => fakeContext('<p>start</p>', {
  chapters: [
    { id: 'doc-2', title: '第二章', content: PLAIN },
    { id: 'doc-3', title: '第三章', content: FORMATTED },
    { id: 'doc-4', title: '第四章', content: '<p>一。</p><p>二。</p><p>三。</p><p>四。</p><p>五。</p>' }
  ]
})

describe('several look-ups in one call', () => {
  it('reads several parts of several chapters at once', async () => {
    const f = book()
    const out = await exec(readChapterTool, { parts: [{ chapter: '2', paragraphs: '2-3' }, { chapter: '4', paragraphs: '4-5' }, { chapter: '4', paragraphs: '1' }] }, f.ctx)
    expect(out.ok).toBe(true)
    expect(out.content).toContain('¶2 阿青推开门。')
    expect(out.content).toContain('¶3 屋里没有人。')
    expect(out.content).toContain('¶4 四。\n¶5 五。')
    expect(out.content).toContain('¶1 一。')
    expect(out.trace).toBe('📖 read #2 "第二章" ¶2–3 (0.0k, text), #4 "第四章" ¶4–5 (0.0k, text), #4 "第四章" ¶1–1 (0.0k, text)')
  })

  it('names a bad part and refuses too many', async () => {
    const f = book()
    expect((await exec(readChapterTool, { parts: [{ chapter: '2', paragraphs: 'abc' }] }, f.ctx)).content).toContain('part 1: paragraphs must look like')
    expect((await exec(readChapterTool, { parts: [{ paragraphs: '1' }] }, f.ctx)).content).toContain('part 1 names no chapter')
    expect((await exec(readChapterTool, { parts: Array.from({ length: 13 }, () => ({ chapter: '2' })) }, f.ctx)).content).toContain('at most 12 parts')
    const out = await exec(readChapterTool, { parts: [{ chapter: '9' }, { chapter: '4', paragraphs: '2' }] }, f.ctx)
    expect(out.ok).toBe(false)
    expect(out.content).toContain('¶2 二。')
  })

  it('searches several patterns, each reported on its own', async () => {
    const f = book()
    const out = await exec(grepTool, { patterns: ['阿青', '五|六', '不存在'] }, f.ctx)
    expect(out.content).toContain('=== /阿青/ ===\n2 match(es) in 2 chapter(s):')
    expect(out.content).toContain('=== /五|六/ ===\n1 match(es) in 1 chapter(s):\n#4 "第四章" ¶5: 五。')
    expect(out.content).toContain('=== /不存在/ ===\nNo matches for /不存在/.')
    expect(out.trace).toBe('🔎 grep 3 patterns in the whole book → /阿青/ 2, /五|六/ 1, /不存在/ 0 (3 in all)')
    expect((await exec(grepTool, { patterns: Array.from({ length: 11 }, (_, i) => `p${i}`) }, f.ctx)).content).toContain('at most 10 patterns')
  })

  it('answers a single pattern exactly as before', async () => {
    const f = book()
    const out = await exec(grepTool, { pattern: '五' }, f.ctx)
    expect(out.content).toBe('1 match(es) in 1 chapter(s):\n#4 "第四章" ¶5: 五。')
    expect(out.trace).toBe('🔎 grep /五/ in the whole book → 1 match in 1 chapter(s)')
  })
})

describe('a whole rewrite needs the text, not the HTML, of a plain chapter', () => {
  it('rewrites a plain chapter whose whole text was read', async () => {
    const f = book()
    expect((await exec(updateDocumentTool, { chapter: '2', html: '<p>新的。</p>' }, f.ctx)).trace).toBe('⛔ rewrite of #2 "第二章" refused — not read yet')
    await exec(readChapterTool, { chapters: ['2'] }, f.ctx)
    const out = await exec(updateDocumentTool, { chapter: '2', html: '<h1>第二章</h1><p>新的。</p>' }, f.ctx)
    expect(out.ok).toBe(true)
    expect(stripDiffMarkup(f.lastWrite('doc-2')!)).toBe('<h1>第二章</h1><p>新的。</p>')
  })

  it('a partial read is not enough', async () => {
    const f = book()
    await exec(readChapterTool, { chapters: ['2'], paragraphs: '1-2' }, f.ctx)
    expect((await exec(updateDocumentTool, { chapter: '2', html: '<p>x</p>' }, f.ctx)).ok).toBe(false)
  })

  it('a chapter with formatting still needs its HTML read, and the refusal says so', async () => {
    const f = book()
    await exec(readChapterTool, { chapters: ['3'] }, f.ctx)
    const out = await exec(updateDocumentTool, { chapter: '3', html: '<p>x</p>' }, f.ctx)
    expect(out.ok).toBe(false)
    expect(out.content).toContain('formatting or images a text read does not show')
  })

  it('the text in context at the start counts, until the chapter changes', async () => {
    const f = book()
    f.ctx.run.textSeen.set('doc-2', (await import('../../utils/contextLedger')).hashContent(PLAIN))
    f.userEdits('doc-2', `${PLAIN}<p>用户加的。</p>`)
    expect((await exec(updateDocumentTool, { chapter: '2', html: '<p>x</p>' }, f.ctx)).ok).toBe(false)
    const g = book()
    g.ctx.run.textSeen.set('doc-2', (await import('../../utils/contextLedger')).hashContent(PLAIN))
    expect((await exec(updateDocumentTool, { chapter: '2', html: '<p>x</p>' }, g.ctx)).ok).toBe(true)
  })
})

describe('edit_paragraphs', () => {
  it('changes paragraphs by number, as a reviewable diff, keeping every other byte', async () => {
    const f = book()
    const out = await exec(editParagraphsTool, {
      chapter: '4',
      edits: [
        { paragraph: 2, action: 'replace', html: '<p>贰。</p>', starts_with: '二' },
        { paragraph: 4, action: 'delete', starts_with: '¶4 四' },
        { paragraph: 5, action: 'insert_after', html: '六。', starts_with: '五' }
      ]
    }, f.ctx)
    expect(out.ok).toBe(true)
    expect(out.trace).toBe('✏️ edited #4 "第四章" by paragraph (3 changes)')
    expect(out.content).toContain('It now has 5 paragraphs')
    expect(stripDiffMarkup(f.lastWrite('doc-4')!)).toBe('<p>一。</p><p>贰。</p><p>三。</p><p>五。</p><p>六。</p>')
    expect(f.lastWrite('doc-4')).toContain('diff-')
  })

  // run-d9e54ca576dc: all-or-nothing threw away two good edits for four mistyped anchors.
  it('applies the edits that fit and returns the stale one with the current text', async () => {
    const f = book()
    const out = await exec(editParagraphsTool, {
      chapter: '4',
      edits: [{ paragraph: 1, action: 'replace', html: '<p>x</p>', starts_with: '一' }, { paragraph: 3, action: 'delete', starts_with: '二' }]
    }, f.ctx)
    expect(out.ok).toBe(true)
    expect(out.content).toContain('NOT applied (1)')
    expect(out.content).toContain('¶3 does not start with what you gave; it now reads: 三。')
    expect(stripDiffMarkup(f.lastWrite('doc-4')!)).toBe('<p>x</p><p>二。</p><p>三。</p><p>四。</p><p>五。</p>')
    expect(out.trace).toContain('1 change; 1 not applied')
  })

  it('applies nothing when no anchor matches', async () => {
    const f = book()
    const out = await exec(editParagraphsTool, { chapter: '4', edits: [{ paragraph: 3, action: 'delete', starts_with: '二' }] }, f.ctx)
    expect(out.ok).toBe(false)
    expect(f.lastWrite('doc-4')).toBeUndefined()
    expect(out.trace).toContain('1 anchor out of date')
  })

  it('keeps a list entry an entry, and lands an anchor with a one-character slip', async () => {
    const card = '<h1>人物卡</h1><h2>姬雪</h2><ul><li><p>身份：缥缈宗太上长老，炼虚期。</p></li><li><p>气运：SSS级。</p></li></ul>'
    const f = fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '人物卡', content: card }] })
    const read = await exec(readChapterTool, { chapters: ['2'] }, f.ctx)
    expect(read.content).toContain('¶3 • 身份：缥缈宗太上长老，炼虚期。')
    expect(read.content).toContain('to rewrite it whole, read it with format="html" first')
    const out = await exec(editParagraphsTool, {
      chapter: '2',
      edits: [{ paragraph: 3, action: 'replace', html: '<p>身份：缥缈宗太上长老，化神期。</p>', starts_with: '身份：缆缈宗太上长老' }]
    }, f.ctx)
    expect(out.ok).toBe(true)
    expect(stripDiffMarkup(f.lastWrite('doc-2')!)).toBe('<h1>人物卡</h1><h2>姬雪</h2><ul><li><p>身份：缥缈宗太上长老，化神期。</p></li><li><p>气运：SSS级。</p></li></ul>')
  })

  it('reads a list of scattered paragraphs in one call', async () => {
    const f = book()
    const out = await exec(readChapterTool, { chapters: ['4'], paragraphs: '1,3-4，5' }, f.ctx)
    expect(out.ok).toBe(true)
    expect(out.content).toContain('¶1 一。')
    expect(out.content).toContain('¶3 三。\n¶4 四。')
    expect(out.content).toContain('¶5 五。')
    expect(out.content).not.toContain('¶2 二。')
  })

  it('refuses a chapter the user edited meanwhile', async () => {
    const f = book()
    await exec(readChapterTool, { chapters: ['4'], format: 'html' }, f.ctx)
    f.userEdits('doc-4', '<p>用户。</p>')
    const out = await exec(editParagraphsTool, { chapter: '4', edits: [{ paragraph: 1, action: 'delete', starts_with: '一' }] }, f.ctx)
    expect(out.trace).toContain('edited by the user meanwhile')
  })

  it('takes numbers written as ¶3 and rejects an unknown action', async () => {
    const f = book()
    expect((await exec(editParagraphsTool, { chapter: '4', edits: [{ paragraph: '¶3', action: 'delete', starts_with: '三' }] }, f.ctx)).ok).toBe(true)
    expect((await exec(editParagraphsTool, { chapter: '4', edits: [{ paragraph: 3, action: 'move', starts_with: 'x' }] }, f.ctx)).content).toContain('action must be one of')
    expect((await exec(editParagraphsTool, { chapter: '4', edits: [] }, f.ctx)).content).toContain('no edits were given')
  })
})

describe('a write marks plan items done', () => {
  const plan = async (f: ReturnType<typeof book>) => exec(planTool, { items: [{ id: 'ch2', title: '改写第二章', status: 'in_progress' }, { id: 'ch4', title: '改写第四章' }] }, f.ctx)

  it('plan_done on a write marks the item and starts the next one', async () => {
    const f = book()
    await plan(f)
    await exec(readChapterTool, { chapters: ['2'] }, f.ctx)
    const out = await exec(updateDocumentTool, { chapter: '2', html: '<p>新。</p>', plan_done: ['ch2'] }, f.ctx)
    expect(out.ok).toBe(true)
    expect(out.trace).toContain('· 📋 plan 1/2')
    expect(out.content).toContain('☑ 改写第二章\n▶ 改写第四章')
    expect(f.ctx.run.plan.map(i => i.status)).toEqual(['done', 'in_progress'])
  })

  it('a refused write marks nothing, and an unknown id is said', async () => {
    const f = book()
    await plan(f)
    const refused = await exec(updateDocumentTool, { chapter: '2', html: '<p>新。</p>', plan_done: 'ch2' }, f.ctx)
    expect(refused.ok).toBe(false)
    expect(f.ctx.run.plan[0].status).toBe('in_progress')
    const out = await exec(editParagraphsTool, { chapter: '4', edits: [{ paragraph: 1, action: 'delete', starts_with: '一' }], plan_done: 'ch4, nope' }, f.ctx)
    expect(out.content).toContain('(plan_done: "nope" is not in the plan.)')
    expect(f.ctx.run.plan[1].status).toBe('done')
  })

  it('a plan_done attribute on a tag goes to the reply\'s last write', () => {
    expect(planDoneAttributes('<canvas chapter="2" plan_done="ch2, ch3">x</canvas><edit plan_done=\'ch3，ch4\'>')).toEqual(['ch2', 'ch3', 'ch4'])
    const registry = new ToolRegistry([...DOCUMENT_WRITE_TOOLS])
    const step = collectStep('ok\n<edit chapter="2">\n<<<<<<< SEARCH\n<p>a</p>\n=======\n<p>b</p>\n>>>>>>> REPLACE\n</edit>\n<canvas chapter="3" plan_done="ch3">text</canvas>\n<doc_status>updated</doc_status>', [], registry, 0, { markupProtocol: true })
    const names = step.invocations.map(i => i.name)
    const last = step.invocations[step.invocations.length - 1]
    expect(names).toEqual(['edit_document', 'update_document'])
    expect(last.args?.plan_done).toEqual(['ch3'])
    expect(step.invocations.slice(0, -1).every(i => i.args?.plan_done === undefined)).toBe(true)
  })
})
