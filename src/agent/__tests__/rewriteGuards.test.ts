/**
 * Whole rewrites that would lose text (run-737f3d809b45, 2026-10-10): asked
 * to bring a timeline up to chapter 87, the model rewrote it 21% shorter and
 * folded chapters 1–61 into "第1–61章：见原条目。". Mirrors the Python cases
 * in scripts/test_agent.py.
 */
import { describe, it, expect } from 'vitest'
import { stripDiffMarkup } from '../../utils/diff'
import { readChapterTool } from '../tools/bookReads'
import { updateDocumentTool } from '../tools/documentWrites'
import type { ToolInvocation, ToolResult } from '../types'
import { fakeContext } from './fakeContext'

const call = (name: string, args: Record<string, unknown>): ToolInvocation => ({ id: `c-${name}`, name, args, source: 'native' })
const exec = async (tool: { name: string; invoke: (inv: ToolInvocation, ctx: never) => ToolResult | Promise<ToolResult> }, args: Record<string, unknown>, ctx: unknown) =>
  tool.invoke(call(tool.name, args), ctx as never)

const entry = (n: number) => `<p>第${n}章：${'事件'.repeat(20)}，人物${n}登场。</p>`
const TIMELINE = '<h1>时间线</h1>' + Array.from({ length: 20 }, (_, i) => entry(i + 1)).join('')
const book = () => fakeContext('<p>start</p>', { chapters: [{ id: 'doc-2', title: '时间线', content: TIMELINE }] })

describe('a whole rewrite that would lose text', () => {
  it('is held back once with what it would drop, and applied when sent again', async () => {
    const f = book()
    await exec(readChapterTool, { chapters: ['2'] }, f.ctx)
    const shorter = '<h1>时间线</h1>' + Array.from({ length: 14 }, (_, i) => entry(i + 1)).join('') + '<p>第21章：新事件。</p>'
    const first = await exec(updateDocumentTool, { chapter: '2', html: shorter }, f.ctx)
    expect(first.ok).toBe(false)
    expect(first.content).toContain('was NOT applied')
    expect(first.content).toContain('edit_paragraphs')
    expect(first.trace).toMatch(/held back — would drop \d+%/)
    expect(stripDiffMarkup(f.lastWrite('doc-2') ?? TIMELINE)).toBe(TIMELINE)

    const second = await exec(updateDocumentTool, { chapter: '2', html: shorter }, f.ctx)
    expect(second.ok).toBe(true)
    expect(stripDiffMarkup(f.lastWrite('doc-2')!)).toContain('第21章：新事件')
  })

  it('lets a rewrite that keeps the text through', async () => {
    const f = book()
    await exec(readChapterTool, { chapters: ['2'] }, f.ctx)
    const longer = TIMELINE + '<p>第21章：新事件。</p>'
    expect((await exec(updateDocumentTool, { chapter: '2', html: longer }, f.ctx)).ok).toBe(true)
  })

  it('refuses "见原条目" as an abbreviation, whatever the length', async () => {
    const f = book()
    await exec(readChapterTool, { chapters: ['2'] }, f.ctx)
    const folded = '<h1>时间线</h1><p>第1–19章：见原条目。</p>' + Array.from({ length: 30 }, (_, i) => entry(i + 20)).join('')
    const out = await exec(updateDocumentTool, { chapter: '2', html: folded }, f.ctx)
    expect(out.ok).toBe(false)
    expect(out.trace).toContain('not applied (elided)')
  })
})
