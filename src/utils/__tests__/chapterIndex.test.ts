import { describe, it, expect } from 'vitest'
import {
  buildChapterIndex,
  packChaptersIntoBatches,
  type IndexableDoc
} from '../chapterIndex'

const makeDoc = (overrides: Partial<IndexableDoc> = {}): IndexableDoc => ({
  id: 'doc-1',
  title: 'Chapter 1: Origins',
  content: '<h1>Origins</h1><p>Riva discovers the buried archive.</p>',
  ...overrides
})



// ── buildChapterIndex ─────────────────────────────────────────────────────────
describe('buildChapterIndex', () => {
  const docs: IndexableDoc[] = [
    makeDoc({ id: 'a', title: 'Chapter 1: Origins' }),
    makeDoc({ id: 'b', title: 'Chapter 2: The Crossing', content: '<p>They cross the river.</p>' }),
    makeDoc({ id: 'c', title: 'Chapter 3: Ashfall' })
  ]

  it('returns empty string for single-document books', () => {
    expect(buildChapterIndex([docs[0]], 'a')).toBe('')
    expect(buildChapterIndex([], null)).toBe('')
  })

  it('lists every chapter by number and title, and nothing of its text', () => {
    const index = buildChapterIndex(docs, 'a')
    expect(index).toContain('CHAPTER INDEX')
    expect(index.split('\n').slice(1)).toEqual([
      '1. "Chapter 1: Origins" [ACTIVE — this is the document you can edit]',
      '2. "Chapter 2: The Crossing"',
      '3. "Chapter 3: Ashfall"'
    ])
    expect(index).not.toContain('They cross the river.')
  })

  it('carries the freshness markers and the agent wording of the active line', () => {
    const index = buildChapterIndex(docs, 'b', { agentTools: true, markers: { c: 'read earlier, not in context' } })
    expect(index).toContain('2. "Chapter 2: The Crossing" [ACTIVE — open in the editor; writes go here unless you name another chapter]')
    expect(index).toContain('3. "Chapter 3: Ashfall" [read earlier, not in context]')
  })
})


// ── packChaptersIntoBatches ───────────────────────────────────────────────────
describe('packChaptersIntoBatches', () => {
  const doc = (id: string, size: number) => ({ id, content: 'x'.repeat(size) })

  it('packs greedily in order under the budget', () => {
    const batches = packChaptersIntoBatches([doc('a', 40), doc('b', 40), doc('c', 40)], 100)
    expect(batches.map(b => b.map(d => d.id))).toEqual([['a', 'b'], ['c']])
  })

  it('preserves book order across batches and never reorders to fill gaps', () => {
    // 'b' would fit alongside 'a', but 'c' comes after — packing stays in order.
    const batches = packChaptersIntoBatches([doc('a', 90), doc('b', 20), doc('c', 90)], 100)
    expect(batches.map(b => b.map(d => d.id))).toEqual([['a'], ['b'], ['c']])
    expect(batches.flat().map(d => d.id)).toEqual(['a', 'b', 'c'])
  })

  it('gives an oversized chapter its own batch instead of dropping it', () => {
    const batches = packChaptersIntoBatches([doc('small', 10), doc('huge', 500), doc('tail', 10)], 100)
    expect(batches.flat().map(d => d.id)).toEqual(['small', 'huge', 'tail'])
    expect(batches.some(b => b.length === 1 && b[0].id === 'huge')).toBe(true)
  })

  it('returns empty for no docs', () => {
    expect(packChaptersIntoBatches([], 100)).toEqual([])
  })
})
