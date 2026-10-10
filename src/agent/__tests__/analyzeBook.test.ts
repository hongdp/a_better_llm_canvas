import { describe, it, expect, vi } from 'vitest'
import { analyzeInBatches, type AnalyzeTransport } from '../analyzeBook'
import { readTool, listTool } from '../tools/bookReads'
import { ToolRegistry } from '../registry'
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

// read with a task (read_and_list.md §2): what analyze_book did, now only
// when what was asked for does not fit in one read.
describe('read with a task', () => {
  const call = (args: Record<string, unknown>, name = 'read'): ToolInvocation => ({ id: 'a', name, args, source: 'native' })
  const book = () => fakeContext('<p>序章。</p>', {
    chapters: [
      { id: 'doc-2', title: '第一章', content: '<p>一</p>' },
      { id: 'doc-3', title: '第二章', content: '' },
      { id: 'doc-4', title: '第三章', content: Array.from({ length: 30 }, (_, i) => `<p>${'长'.repeat(1000)}${i}</p>`).join('') }
    ],
    lazy: { 'doc-3': '<p>二</p>' }
  })
  const notesPort = () => vi.fn(async (_task: string, chapters: { title: string }[]) => ({ notes: `read ${chapters.map(c => c.title).join('、')}`, batches: 2, total: 2, stopped: false }))

  it('is always offered; without a model, a task-read too long for one read says to read it in parts', async () => {
    const f = book()
    expect(readTool.isAvailable(f.ctx)).toBe(true)
    const r = await (readTool.invoke(call({ task: '人物关系' }), f.ctx) as Promise<ToolResult>)
    expect(r.ok).toBe(false)
    expect(r.content).toContain('read it part by part')
  })

  it('reads the whole book for a task (lazy chapters loaded) and returns the notes, with the call count in the trace', async () => {
    const f = book()
    const run = notesPort()
    f.ctx.analyze = { run }
    const r = await (readTool.invoke(call({ task: '人物关系' }), f.ctx) as Promise<ToolResult>)
    expect(run.mock.calls[0][1].map(c => c.title)).toEqual(['Chapter 1', '第一章', '第二章', '第三章'])
    expect(r.ok).toBe(true)
    expect(r.content).toContain('read Chapter 1、第一章、第二章、第三章')
    expect(r.trace).toBe('📚 read the book for a task — 4 parts, 2 model calls')
  })

  it('returns the text, not notes, when what was named fits in one read — no model call', async () => {
    const f = book()
    const run = notesPort()
    f.ctx.analyze = { run }
    const r = await (readTool.invoke(call({ task: 't', chapters: ['2'] }), f.ctx) as Promise<ToolResult>)
    expect(run).not.toHaveBeenCalled()
    expect(r.content).toContain('¶1 一')
  })

  it('reads a chapter too long for one read in batches, honoring its range', async () => {
    const f = book()
    const run = notesPort()
    f.ctx.analyze = { run }
    const r = await (readTool.invoke(call({ task: 't', chapters: ['4'], paragraphs: '1-25' }), f.ctx) as Promise<ToolResult>)
    expect(run.mock.calls[0][1].map(c => c.title)).toEqual(['第三章 (¶1–25)'])
    expect(r.trace).toBe('📚 read #4 ¶1–25 for a task — 1 part, 2 model calls')
  })

  it('says what the rest would cost when a read without a task is cut short', async () => {
    const f = book()
    f.ctx.analyze = { run: notesPort(), plan: () => ({ calls: 1, inputTokens: 31_000, batchChars: 140_000 }) }
    const r = await (readTool.invoke(call({ chapters: ['4'] }), f.ctx) as Promise<ToolResult>)
    expect(r.ok).toBe(true)
    expect(r.content).toContain('Continue with chapters=[4]')
    expect(r.content).toContain('[Not all of it fit in one read. To have all of it read and get notes, call read again with the same arguments and task="what the notes are for": 1 batch outside the conversation, ≈31k input tokens.]')
  })

  it('answers to its old names, read_chapter and analyze_book, and list to list_chapters', () => {
    const registry = new ToolRegistry([readTool, listTool])
    expect(registry.get('read_chapter')).toBe(readTool)
    expect(registry.get('analyze_book')).toBe(readTool)
    expect(registry.get('list_chapters')).toBe(listTool)
    expect(() => new ToolRegistry([readTool, { ...listTool, name: 'analyze_book', aliases: [] }])).toThrow('already registered')
  })
})
