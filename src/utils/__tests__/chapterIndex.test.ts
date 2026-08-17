import { describe, it, expect } from 'vitest'
import { detectSummaryLanguage,
  hashDocumentContent,
  isSummaryStale,
  getChapterDigest,
  buildChapterIndex,
  buildSummaryInput,
  extractHeadingTree,
  buildWholeBookDigest,
  packChaptersIntoBatches,
  type IndexableDoc
} from '../chapterIndex'

const makeDoc = (overrides: Partial<IndexableDoc> = {}): IndexableDoc => ({
  id: 'doc-1',
  title: 'Chapter 1: Origins',
  content: '<h1>Origins</h1><p>Riva discovers the buried archive.</p>',
  ...overrides
})

// ── hashDocumentContent ───────────────────────────────────────────────────────
describe('hashDocumentContent', () => {
  it('is deterministic for the same content', () => {
    expect(hashDocumentContent('hello world')).toBe(hashDocumentContent('hello world'))
  })

  it('differs for different content', () => {
    expect(hashDocumentContent('hello world')).not.toBe(hashDocumentContent('hello world!'))
  })

  it('handles empty and unicode content', () => {
    expect(hashDocumentContent('')).toMatch(/^[0-9a-f]+$/)
    expect(hashDocumentContent('第一章：起源')).toMatch(/^[0-9a-f]+$/)
    expect(hashDocumentContent('第一章：起源')).not.toBe(hashDocumentContent('第二章：渡河'))
  })
})

// ── isSummaryStale ────────────────────────────────────────────────────────────
describe('isSummaryStale', () => {
  it('is stale when there is no summary', () => {
    expect(isSummaryStale(makeDoc())).toBe(true)
  })

  it('is fresh when the hash matches current content', () => {
    const doc = makeDoc()
    doc.summary = 'Riva finds an archive.'
    doc.summaryContentHash = hashDocumentContent(doc.content)
    expect(isSummaryStale(doc)).toBe(false)
  })

  it('is stale after the content changes', () => {
    const doc = makeDoc()
    doc.summary = 'Riva finds an archive.'
    doc.summaryContentHash = hashDocumentContent(doc.content)
    doc.content += '<p>New paragraph.</p>'
    expect(isSummaryStale(doc)).toBe(true)
  })

  it('is stale when a summary exists but the hash is missing', () => {
    const doc = makeDoc({ summary: 'Some summary' })
    expect(isSummaryStale(doc)).toBe(true)
  })
})

// ── getChapterDigest ──────────────────────────────────────────────────────────
describe('getChapterDigest', () => {
  it('uses the generated summary when present', () => {
    const doc = makeDoc({ summary: 'The generated summary.' })
    expect(getChapterDigest(doc)).toBe('The generated summary.')
  })

  it('falls back to plain text of the content when no summary exists', () => {
    const digest = getChapterDigest(makeDoc())
    expect(digest).toContain('Origins')
    expect(digest).toContain('Riva discovers the buried archive.')
    expect(digest).not.toContain('<h1>')
  })

  it('flattens newlines into single-line output', () => {
    const doc = makeDoc({ summary: 'Line one.\nLine two.\n- bullet' })
    expect(getChapterDigest(doc)).toBe('Line one. Line two. - bullet')
  })

  it('truncates to maxChars with an ellipsis', () => {
    const doc = makeDoc({ summary: 'x'.repeat(500) })
    const digest = getChapterDigest(doc, 100)
    expect(digest.length).toBe(101) // 100 chars + ellipsis
    expect(digest.endsWith('…')).toBe(true)
  })

  it('uses a stale summary rather than falling back (staleness is tolerated)', () => {
    const doc = makeDoc({ summary: 'Old but useful summary.', summaryContentHash: 'stale' })
    expect(getChapterDigest(doc)).toBe('Old but useful summary.')
  })
})

// ── buildChapterIndex ─────────────────────────────────────────────────────────
describe('buildChapterIndex', () => {
  const docs: IndexableDoc[] = [
    makeDoc({ id: 'a', title: 'Chapter 1: Origins', summary: 'Riva finds the archive.' }),
    makeDoc({ id: 'b', title: 'Chapter 2: The Crossing', content: '<p>They cross the river.</p>' }),
    makeDoc({ id: 'c', title: 'Chapter 3: Ashfall', summary: 'The siege begins.' })
  ]

  it('returns empty string for single-document books', () => {
    expect(buildChapterIndex([docs[0]], 'a')).toBe('')
    expect(buildChapterIndex([], null)).toBe('')
  })

  it('lists every chapter with numbering and titles', () => {
    const index = buildChapterIndex(docs, 'b')
    expect(index).toContain('CHAPTER INDEX')
    expect(index).toContain('1. "Chapter 1: Origins" — Riva finds the archive.')
    expect(index).toContain('3. "Chapter 3: Ashfall" — The siege begins.')
  })

  it('marks the active chapter and omits its digest', () => {
    const index = buildChapterIndex(docs, 'b')
    expect(index).toContain('2. "Chapter 2: The Crossing" [ACTIVE — this is the document you can edit]')
    expect(index).not.toContain('They cross the river.')
  })

  it('uses the plain-text fallback for chapters without summaries', () => {
    const index = buildChapterIndex(docs, 'a')
    expect(index).toContain('They cross the river.')
  })

  it('clamps digests harder for very large books', () => {
    const longSummary = 'y'.repeat(400)
    const many = Array.from({ length: 45 }, (_, i) =>
      makeDoc({ id: `d${i}`, title: `Chapter ${i + 1}`, summary: longSummary })
    )
    const index = buildChapterIndex(many, 'd0')
    const line = index.split('\n').find(l => l.startsWith('2. '))
    expect(line).toBeDefined()
    expect(line!.length).toBeLessThan(200)
  })
})

// ── buildSummaryInput ─────────────────────────────────────────────────────────
describe('buildSummaryInput', () => {
  it('converts HTML to plain text', () => {
    const input = buildSummaryInput(makeDoc())
    expect(input).not.toContain('<h1>')
    expect(input).toContain('Origins')
  })

  it('truncates giant chapters with an explicit notice', () => {
    const doc = makeDoc({ content: `<p>${'z'.repeat(50_000)}</p>` })
    const input = buildSummaryInput(doc, 10_000)
    expect(input.length).toBeLessThan(11_000)
    expect(input).toContain('[truncated')
  })
})

// ── extractHeadingTree ────────────────────────────────────────────────────────
describe('extractHeadingTree', () => {
  it('extracts h1-h3 with indentation by level', () => {
    const html = '<h1>Book Part</h1><p>text</p><h2>Section A</h2><p>more</p><h3>Detail</h3>'
    expect(extractHeadingTree(html)).toBe('- Book Part\n  - Section A\n    - Detail')
  })

  it('ignores h4+ and strips inline markup and attributes', () => {
    const html = '<h2 id="x">The <strong>Siege</strong></h2><h4>ignored</h4>'
    expect(extractHeadingTree(html)).toBe('  - The Siege')
  })

  it('returns empty string for heading-less content', () => {
    expect(extractHeadingTree('<p>Just prose.</p>')).toBe('')
  })
})

// ── buildWholeBookDigest ──────────────────────────────────────────────────────
describe('buildWholeBookDigest', () => {
  it('includes every chapter with headings, summary, and active marker', () => {
    const docs: IndexableDoc[] = [
      makeDoc({ id: 'a', title: 'Chapter 1', content: '<h1>Origins</h1><p>Riva digs.</p>', summary: 'Riva finds the archive.' }),
      makeDoc({ id: 'b', title: 'Chapter 2', content: '<h1>Crossing</h1><p>They cross.</p>' })
    ]
    const digest = buildWholeBookDigest(docs, 'b')
    expect(digest).toContain('WHOLE-BOOK DIGEST')
    expect(digest).toContain('1. "Chapter 1"')
    expect(digest).toContain('- Origins')
    expect(digest).toContain('Summary: Riva finds the archive.')
    expect(digest).toContain('2. "Chapter 2" (ACTIVE)')
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

// ── hash stability across markup churn ────────────────────────────────────────
describe('hashDocumentContent stability', () => {
  it('ignores markup differences that do not change the reading text', () => {
    const a = '<p>第一行</p><p>第二行</p>'
    const b = '<p>第一行<br>第二行</p>'          // before <br> normalization
    const c = '<p class="x">第一行</p>\n<p>第二行</p>' // editor re-serialization
    expect(hashDocumentContent(b)).toBe(hashDocumentContent(a))
    expect(hashDocumentContent(c)).toBe(hashDocumentContent(a))
  })

  it('still changes when the actual text changes', () => {
    expect(hashDocumentContent('<p>原文</p>')).not.toBe(hashDocumentContent('<p>改过的原文</p>'))
  })

  it('a summary survives a markup-only rewrite', () => {
    const doc = makeDoc({ content: '<p>甲<br>乙</p>' })
    doc.summary = 'S'
    doc.summaryContentHash = hashDocumentContent(doc.content)
    doc.content = '<p>甲</p><p>乙</p>' // what normalization produces
    expect(isSummaryStale(doc)).toBe(false)
  })
})

// ── detectSummaryLanguage ────────────────────────────────────────────────────
// Picks which instruction to send. An English "same language as the chapter"
// instruction mostly works and then occasionally does not — measured 83%, 83%,
// 0% Chinese across three runs, the failure also blowing the length cap — while
// the Chinese instruction held at 82-87%. This buys consistency, not capability.
describe('detectSummaryLanguage', () => {
  it('recognises Chinese prose', () => {
    expect(detectSummaryLanguage('垃圾站的晨昏线没有晨，也没有昏。太阳只是一块被滤镜削薄的白斑。')).toBe('zh')
  })

  it('separates Japanese from Chinese by kana, not by han', () => {
    // Han characters alone are shared; the kana is the giveaway.
    expect(detectSummaryLanguage('彼は宇宙船の中で目を覚ました。窓の外には星が流れていた。')).toBe('ja')
  })

  it('recognises Korean', () => {
    expect(detectSummaryLanguage('그는 우주선 안에서 눈을 떴다. 창밖으로 별이 흐르고 있었다.')).toBe('ko')
  })

  it('leaves Latin prose to the English instruction', () => {
    expect(detectSummaryLanguage('The junkyard had no dawn and no dusk, only a filtered white smear.')).toBe('other')
  })

  it('is not fooled by a stray CJK name in English prose', () => {
    // A quoted name must not flip a whole English chapter to a Chinese prompt.
    expect(detectSummaryLanguage('Shen Jianchuan (沈见川) worked the night shift at the orbital junkyard for fourteen months, and never once spoke of it.')).toBe('other')
  })

  it('handles empty input', () => {
    expect(detectSummaryLanguage('')).toBe('other')
  })
})
