import { describe, it, expect, vi } from 'vitest'
import { polishHtml, type PolishTransport } from '../polish'
import { polishChapterTool } from '../tools/polishChapter'
import { stripDiffMarkup } from '../../utils/diff'
import type { ToolInvocation, ToolResult } from '../types'
import { fakeContext } from './fakeContext'

const prompt = { system: 'SYS', template: '{part}' }
/** One ~660-char paragraph of 10-char clauses (no run-on). */
const para = (c: string) => `<p>${`${c.repeat(10)}，`.repeat(59)}${c.repeat(10)}。</p>`
/** Three paragraphs: chunk 1 = 甲+乙 (≥ 1000 chars), chunk 2 = 丙. */
const CHAPTER = ['甲', '乙', '丙'].map(para).join('')
/** A rewrite that passes: same paragraphs, slightly longer. */
const passing = (user: string) => user.replace(/。<\/p>/g, '多了几个字。</p>')

describe('polishHtml', () => {
  it('sends every chunk at once, and puts the passing rewrites in place', async () => {
    const started: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const transport: PolishTransport = vi.fn(async (_s, user) => {
      started.push(user)
      await gate
      return passing(user)
    })
    const pending = polishHtml(CHAPTER, { transport, prompt })
    await Promise.resolve()
    // Both chunks are in flight before either answers: 26–53 s a chapter, not minutes.
    expect(started).toHaveLength(2)
    release()
    const out = await pending
    expect(out).toMatchObject({ chunks: 2, polished: 2, kept: [], stopped: false })
    expect(out.html).toContain('多了几个字')
  })

  it('appends the writing preset to the system prompt', async () => {
    const transport = vi.fn<PolishTransport>(async (_s, user) => passing(user))
    await polishHtml('<p>一句话。</p>', { transport, prompt, writingPreset: '  PRESET  ' })
    expect(transport.mock.calls[0][0]).toBe('SYS\n\nPRESET')
  })

  it('keeps the draft of a chunk that fails the checks, and says why', async () => {
    const transport: PolishTransport = async (_s, user) => (user.includes('甲') ? passing(user) : '<p>短。</p>')
    const out = await polishHtml(CHAPTER, { transport, prompt })
    expect(out.polished).toBe(1)
    expect(out.kept[0]).toMatch(/^chunk 2: length -\d+%/)
    expect(out.html).toContain(para('丙'))
  })

  it('on Stop keeps what finished and drafts for the rest', async () => {
    const controller = new AbortController()
    const transport: PolishTransport = (_s, user, signal) => user.includes('甲')
      ? Promise.resolve(passing(user))
      : new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    const pending = polishHtml(CHAPTER, { transport, prompt, signal: controller.signal })
    await new Promise(r => setTimeout(r, 0))
    controller.abort()
    const out = await pending
    expect(out).toMatchObject({ polished: 1, stopped: true })
    expect(out.kept).toEqual(['chunk 2: stopped'])
  })
})

describe('polish_chapter', () => {
  const call = (args: Record<string, unknown>): ToolInvocation => ({ id: 'p', name: 'polish_chapter', args, source: 'native' })

  it('is offered only where a polish model is wired', () => {
    const f = fakeContext('<p>x</p>')
    expect(polishChapterTool.isAvailable(f.ctx)).toBe(false)
    f.ctx.polish = { run: async html => ({ html, chunks: 1, polished: 0, kept: [], stopped: false }) }
    expect(polishChapterTool.isAvailable(f.ctx)).toBe(true)
  })

  it('writes the polished chapter as a reviewable diff, and makes the model read it again before editing', async () => {
    const f = fakeContext('<p>草稿。</p>', { chapters: [{ id: 'doc-2', title: '第二章', content: '<p>第二章草稿。</p>' }] })
    f.ctx.polish = {
      run: async (html, onProgress) => {
        onProgress(1, 1)
        return { html: html.replace('草稿', '润色稿'), chunks: 1, polished: 1, kept: [], stopped: false }
      }
    }
    f.ctx.run.htmlShown.add('doc-2')
    const r = await (polishChapterTool.invoke(call({ chapter: 2 }), f.ctx) as Promise<ToolResult>)
    expect(r).toMatchObject({ ok: true, trace: '✨ polished #2 "第二章" (1 of 1 chunk(s) rewritten)' })
    expect(stripDiffMarkup(f.lastWrite('doc-2') ?? '')).toBe('<p>第二章润色稿。</p>')
    expect(f.lastWrite('doc-2')).toContain('diff-addition')
    expect(f.ctx.run.htmlShown.has('doc-2')).toBe(false)
    expect(f.ctx.run.touched.get('doc-2')).toMatchObject({ kind: 'polished', changes: 1, failed: 0 })
    expect(f.progress).toContain('✨ polishing #2 "第二章" … 1/1')
  })

  it('changes nothing when no chunk passed', async () => {
    const f = fakeContext('<p>草稿。</p>')
    f.ctx.polish = { run: async html => ({ html, chunks: 2, polished: 0, kept: ['chunk 1: x', 'chunk 2: y'], stopped: false }) }
    const r = await (polishChapterTool.invoke(call({}), f.ctx) as Promise<ToolResult>)
    expect(r.ok).toBe(false)
    expect(f.writes).toEqual([])
  })
})

describe('polish_chapter and the user\'s edits', () => {
  const call = (args: Record<string, unknown>): ToolInvocation => ({ id: 'p', name: 'polish_chapter', args, source: 'native' })

  it('locks the chapter while it polishes, and discards the polish if the stored text moved anyway', async () => {
    const f = fakeContext('<p>草稿。</p>')
    f.ctx.polish = {
      run: async html => {
        f.userEdits('doc-1', '<p>草稿，用户改过。</p>')
        return { html: html.replace('草稿', '润色稿'), chunks: 1, polished: 1, kept: [], stopped: false }
      }
    }
    const r = await (polishChapterTool.invoke(call({}), f.ctx) as Promise<ToolResult>)
    expect(f.writing).toEqual(['doc-1', null])
    expect(r).toMatchObject({ ok: false, retryable: false })
    expect(r.content).toContain('discarded')
    expect(f.writes).toEqual([])
  })
})
