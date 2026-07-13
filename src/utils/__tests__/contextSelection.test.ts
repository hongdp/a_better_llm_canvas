import { describe, it, expect } from 'vitest'
import {
  selectReferenceChapters,
  extractKeywords,
  DEFAULT_SELECTION_OPTIONS,
  type SelectableDoc,
  type SelectionInput
} from '../contextSelection'

const makeDoc = (id: string, title: string, overrides: Partial<SelectableDoc> = {}): SelectableDoc => ({
  id,
  title,
  content: `<p>${'x'.repeat(500)}</p>`,
  ...overrides
})

const baseDocs: SelectableDoc[] = [
  makeDoc('a', 'Chapter 1: Origins', { summary: 'Riva discovers the buried archive beneath the city.' }),
  makeDoc('b', 'Chapter 2: The Crossing'),
  makeDoc('c', 'Chapter 3: Ashfall', { summary: 'The siege begins and Kael betrays the garrison.' }),
  makeDoc('d', 'Chapter 4: Return', { summary: 'The survivors regroup in the mountains.' })
]

const baseInput = (overrides: Partial<SelectionInput> = {}): SelectionInput => ({
  promptText: '',
  recentHistory: [],
  documents: baseDocs,
  activeDocumentId: 'b',
  pinnedIds: [],
  blockedIds: [],
  ...overrides
})

// ── extractKeywords ───────────────────────────────────────────────────────────
describe('extractKeywords', () => {
  it('extracts latin words of 4+ chars, lowercased, without stopwords', () => {
    const kws = extractKeywords('Please rewrite the Archive section about Kael')
    expect(kws).toContain('archive')
    expect(kws).toContain('kael')
    expect(kws).not.toContain('the')
    expect(kws).not.toContain('please')
  })

  it('extracts CJK bigrams so Chinese prompts can match summaries', () => {
    const kws = extractKeywords('把围城那一段写得更紧张')
    expect(kws).toContain('围城')
  })

  it('caps the number of keywords', () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}abc`).join(' ')
    expect(extractKeywords(long, 80).length).toBeLessThanOrEqual(80)
  })
})

// ── selectReferenceChapters: signals ──────────────────────────────────────────
describe('selectReferenceChapters signals', () => {
  it('attaches a chapter whose title is mentioned in the prompt', () => {
    const result = selectReferenceChapters(baseInput({ promptText: 'Compare this with Chapter 3: Ashfall' }))
    expect(result.autoIds).toContain('c')
    expect(result.scores['c']).toBeGreaterThanOrEqual(100)
  })

  it('scores a title mention in recent history lower than in the prompt', () => {
    // 'd' is not adjacent to the active doc, so its score is purely the
    // history-mention signal.
    const result = selectReferenceChapters(baseInput({
      recentHistory: ['Earlier we discussed Chapter 4: Return in detail']
    }))
    expect(result.scores['d']).toBe(60)
  })

  it('only scans the last 4 history messages', () => {
    const result = selectReferenceChapters(baseInput({
      recentHistory: ['We discussed Chapter 3: Ashfall', 'a', 'b', 'c', 'd']
    }))
    expect(result.scores['c']).toBeLessThan(60)
  })

  it('scores adjacent chapters of the active document', () => {
    const result = selectReferenceChapters(baseInput())
    expect(result.scores['a']).toBeGreaterThanOrEqual(40) // prev of active 'b'
    expect(result.scores['c']).toBeGreaterThanOrEqual(40) // next of active 'b'
    expect(result.scores['d']).toBe(0)
  })

  it('scores keyword overlap between prompt and summaries', () => {
    const result = selectReferenceChapters(baseInput({
      promptText: 'Make sure the archive details stay consistent',
      activeDocumentId: 'd'
    }))
    expect(result.scores['a']).toBeGreaterThan(0)
  })

  it('scores continuity for chapters attached on the previous turn', () => {
    const result = selectReferenceChapters(baseInput({ previousAttachedIds: ['d'] }))
    expect(result.scores['d']).toBe(30)
  })

  it('never scores or attaches the active document', () => {
    const result = selectReferenceChapters(baseInput({ promptText: 'Chapter 2: The Crossing' }))
    expect(result.attachedIds).not.toContain('b')
    expect(result.scores['b']).toBeUndefined()
  })
})

// ── selectReferenceChapters: pin/block precedence ─────────────────────────────
describe('selectReferenceChapters pin/block precedence', () => {
  it('always attaches pinned chapters regardless of score', () => {
    const result = selectReferenceChapters(baseInput({ pinnedIds: ['d'] }))
    expect(result.attachedIds).toContain('d')
    expect(result.autoIds).not.toContain('d')
  })

  it('never auto-attaches blocked chapters even with a title mention', () => {
    const result = selectReferenceChapters(baseInput({
      promptText: 'Compare with Chapter 3: Ashfall',
      blockedIds: ['c']
    }))
    expect(result.attachedIds).not.toContain('c')
  })

  it('lists pinned chapters before autos', () => {
    const result = selectReferenceChapters(baseInput({
      promptText: 'Compare with Chapter 3: Ashfall',
      pinnedIds: ['d']
    }))
    expect(result.attachedIds.indexOf('d')).toBeLessThan(result.attachedIds.indexOf('c'))
  })
})

// ── selectReferenceChapters: budget ───────────────────────────────────────────
describe('selectReferenceChapters budget', () => {
  it('drops lowest-score autos first when over budget', () => {
    const bigDocs = [
      makeDoc('active', 'Chapter 0: Active'),
      makeDoc('high', 'Chapter 1: Archive', { content: 'y'.repeat(15_000), summary: '' }),
      makeDoc('low', 'Chapter 2: Ashfall', { content: 'z'.repeat(15_000), summary: '' })
    ]
    const result = selectReferenceChapters(
      {
        promptText: 'Look at Chapter 1: Archive and also Chapter 2: Ashfall',
        recentHistory: ['We were just talking about Chapter 1: Archive'],
        documents: bigDocs,
        activeDocumentId: 'active',
        pinnedIds: [],
        blockedIds: []
      },
      { maxTotalChars: 20_000 }
    )
    expect(result.autoIds).toEqual(['high'])
    expect(result.droppedForBudget).toEqual(['low'])
  })

  it('caps each doc at perDocChars when estimating', () => {
    const docs = [
      makeDoc('active', 'Chapter 0'),
      makeDoc('huge', 'Chapter 1: Archive', { content: 'y'.repeat(100_000) })
    ]
    const result = selectReferenceChapters(
      {
        promptText: 'Chapter 1: Archive',
        recentHistory: [],
        documents: docs,
        activeDocumentId: 'active',
        pinnedIds: [],
        blockedIds: []
      },
      { perDocChars: 20_000 }
    )
    expect(result.estimatedChars).toBe(20_000)
    expect(result.autoIds).toContain('huge')
  })

  it('pinned chapters are never dropped even when they exceed the budget', () => {
    const docs = [
      makeDoc('active', 'Chapter 0'),
      makeDoc('p1', 'Chapter 1', { content: 'y'.repeat(20_000) }),
      makeDoc('p2', 'Chapter 2', { content: 'z'.repeat(20_000) })
    ]
    const result = selectReferenceChapters(
      {
        promptText: '',
        recentHistory: [],
        documents: docs,
        activeDocumentId: 'active',
        pinnedIds: ['p1', 'p2'],
        blockedIds: []
      },
      { maxTotalChars: 10_000 }
    )
    expect(result.attachedIds).toEqual(['p1', 'p2'])
  })
})

// ── selectReferenceChapters: unloaded/empty content ───────────────────────────
describe('selectReferenceChapters content availability', () => {
  it('never attaches docs whose content is not loaded', () => {
    const docs = [
      makeDoc('active', 'Chapter 0'),
      makeDoc('lazy', 'Chapter 1: Archive', { content: '', contentLoaded: false })
    ]
    const result = selectReferenceChapters({
      promptText: 'Chapter 1: Archive',
      recentHistory: [],
      documents: docs,
      activeDocumentId: 'active',
      pinnedIds: ['lazy'],
      blockedIds: []
    })
    expect(result.attachedIds).toEqual([])
  })
})

// ── defaults sanity ───────────────────────────────────────────────────────────
describe('DEFAULT_SELECTION_OPTIONS', () => {
  it('keeps the documented defaults', () => {
    expect(DEFAULT_SELECTION_OPTIONS.maxTotalChars).toBe(60_000)
    expect(DEFAULT_SELECTION_OPTIONS.perDocChars).toBe(20_000)
    expect(DEFAULT_SELECTION_OPTIONS.scoreThreshold).toBe(40)
  })
})
