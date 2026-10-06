import { describe, it, expect, vi } from 'vitest'
import { analyzeInBatches, type AnalyzeTransport } from '../analyzeBook'
import { analyzeBookTool } from '../tools/analyzeBook'
import type { ToolInvocation, ToolResult } from '../types'
import { fakeContext } from './fakeContext'

const chapter = (id: string, size: number) => ({ id, title: `第${id}章`, content: `<p>${'字'.repeat(size)}</p>` })

describe('analyzeInBatches', () => {
  it('reads the chapters in book order, batch by batch, carrying the notes forward', async () => {
    const seen: string[] = []
    const transport = vi.fn<AnalyzeTransport>(async (_s, user) => {
      seen.push(user)
      return `notes after batch ${seen.length}`
    })
    const progress: string[] = []
    const out = await analyzeInBatches({
      task: '列出所有伏笔',
      chapters: [chapter('1', 40), chapter('2', 40), chapter('3', 40)],
      budgetChars: 100,
      transport,
      onProgress: (done, total) => progress.push(`${done}/${total}`)
    })

    expect(out).toEqual({ notes: 'notes after batch 2', batches: 2, total: 2, stopped: false })
    expect(seen[0]).toContain('TASK (do not answer it — only update the notes):\n列出所有伏笔')
    expect(seen[0]).toContain('(none yet — this is the first batch)')
    expect(seen[0]).toContain('--- DOCUMENT: 第1章 ---')
    expect(seen[1]).toContain('RUNNING NOTES (from previous batches):\nnotes after batch 1')
    expect(seen[1]).toContain('--- DOCUMENT: 第3章 ---')
    expect(progress).toEqual(['0/2', '1/2', '2/2'])
  })

  it('stops between batches when the run is stopped, keeping the notes so far', async () => {
    const controller = new AbortController()
    const transport: AnalyzeTransport = async () => { controller.abort(); return 'first notes' }
    const out = await analyzeInBatches({
      task: 't', chapters: [chapter('1', 80), chapter('2', 80)], budgetChars: 100, transport, signal: controller.signal
    })
    expect(out).toEqual({ notes: 'first notes', batches: 1, total: 2, stopped: true })
  })

  it('reports a failed batch with the notes of the batches before it', async () => {
    let n = 0
    const transport: AnalyzeTransport = async () => { if (++n === 2) throw new Error('503'); return 'first notes' }
    const out = await analyzeInBatches({ task: 't', chapters: [chapter('1', 80), chapter('2', 80)], budgetChars: 100, transport })
    expect(out).toMatchObject({ notes: 'first notes', batches: 1, total: 2, stopped: false, failed: '503' })
  })
})

describe('analyze_book', () => {
  const call = (args: Record<string, unknown>): ToolInvocation => ({ id: 'a', name: 'analyze_book', args, source: 'native' })
  const book = () => fakeContext('<p>序章。</p>', {
    chapters: [
      { id: 'doc-2', title: '第一章', content: '<p>一</p>' },
      { id: 'doc-3', title: '第二章', content: '' }
    ],
    lazy: { 'doc-3': '<p>二</p>' }
  })

  it('is offered only where a model is wired', () => {
    const f = book()
    expect(analyzeBookTool.isAvailable(f.ctx)).toBe(false)
    f.ctx.analyze = { run: async () => ({ notes: '', batches: 0, total: 0, stopped: false }) }
    expect(analyzeBookTool.isAvailable(f.ctx)).toBe(true)
  })

  it('analyzes the whole book (lazy chapters loaded) and returns the notes, with the call count in the trace', async () => {
    const f = book()
    const run = vi.fn(async (_task: string, chapters: { title: string }[]) => ({ notes: `read ${chapters.map(c => c.title).join('、')}`, batches: 2, total: 2, stopped: false }))
    f.ctx.analyze = { run }
    const r = await (analyzeBookTool.invoke(call({ task: '人物关系' }), f.ctx) as Promise<ToolResult>)

    expect(run.mock.calls[0][1].map(c => c.title)).toEqual(['Chapter 1', '第一章', '第二章'])
    expect(r.ok).toBe(true)
    expect(r.content).toContain('read Chapter 1、第一章、第二章')
    expect(r.trace).toBe('📚 analyzed the book — 3 chapters, 2 model calls')
  })

  it('analyzes only the chapters named, and says which could not be loaded', async () => {
    const f = book()
    f.ensureLoaded.mockImplementation(async () => {})
    const run = vi.fn(async () => ({ notes: 'n', batches: 1, total: 1, stopped: false }))
    f.ctx.analyze = { run }
    const r = await (analyzeBookTool.invoke(call({ task: 't', chapters: ['2', '3'] }), f.ctx) as Promise<ToolResult>)
    expect(r.trace).toBe('📚 analyzed #2, #3 — 1 chapter, 1 model call')
    expect(r.content).toContain('Not read — their text could not be loaded: #3 "第二章"')
  })
})
