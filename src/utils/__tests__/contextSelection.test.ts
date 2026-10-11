import { describe, it, expect } from 'vitest'
import {
  selectReferenceChapters,
  extractKeywords,
  pinnedContextIds,
  PINNED_CONTEXT_CHARS,
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
  makeDoc('a', 'Chapter 1: Origins'),
  makeDoc('b', 'Chapter 2: The Crossing'),
  makeDoc('c', 'Chapter 3: Ashfall'),
  makeDoc('d', 'Chapter 4: Return')
]

const baseInput = (overrides: Partial<SelectionInput> = {}): SelectionInput => ({
  promptText: '',
  recentHistory: [],
  documents: baseDocs,
  activeDocumentId: 'b',
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
  it('admits a chapter the model read with a tool last turn, where continuity alone would not', () => {
    // 'd' is not adjacent to the active 'b': the read is its only signal.
    const continuityOnly = selectReferenceChapters(baseInput({ previousAttachedIds: ['d'] }))
    expect(continuityOnly.autoIds).not.toContain('d')

    const readByModel = selectReferenceChapters(baseInput({ modelReadIds: ['d'] }))
    expect(readByModel.autoIds).toContain('d')
    expect(readByModel.scores['d']).toBe(60)
  })

  it('does not re-score a model-read chapter that is already in the ledger', () => {
    const result = selectReferenceChapters(baseInput({ modelReadIds: ['d'], ledgerIds: ['d'] }))
    expect(result.attachedIds).toContain('d')
    expect(result.autoIds).not.toContain('d')
  })

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

  it('scores keyword overlap between prompt and titles (summaries are no longer used)', () => {
    const result = selectReferenceChapters(baseInput({
      promptText: 'Make sure the origins details stay consistent',
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

// ── selectReferenceChapters: budget ───────────────────────────────────────────
describe('selectReferenceChapters budget', () => {
  it('drops lowest-score autos first when over budget', () => {
    const bigDocs = [
      makeDoc('active', 'Chapter 0: Active'),
      makeDoc('high', 'Chapter 1: Archive', { content: 'y'.repeat(15_000) }),
      makeDoc('low', 'Chapter 2: Ashfall', { content: 'z'.repeat(15_000) })
    ]
    const result = selectReferenceChapters(
      {
        promptText: 'Look at Chapter 1: Archive and also Chapter 2: Ashfall',
        recentHistory: ['We were just talking about Chapter 1: Archive'],
        documents: bigDocs,
        activeDocumentId: 'active',
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
      },
      { perDocChars: 20_000 }
    )
    expect(result.estimatedChars).toBe(20_000)
    expect(result.autoIds).toContain('huge')
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
    })
    expect(result.attachedIds).toEqual([])
  })
})

// ── pinned context (pinned_context.md) ───────────────────────────────────────
describe('pinnedContextIds', () => {
  const docs = [
    { id: 'outline', pinned: true, chars: 5_000 },
    { id: 'ch1', chars: 9_000 },
    { id: 'cards', pinned: true, chars: 20_000 },
    { id: 'setting', pinned: true, chars: 20_000 },
    { id: 'notes', pinned: true, chars: 20_000 },
    { id: 'small', pinned: true, chars: 1_000 }
  ]

  it('takes only pinned chapters, in book order, never the active one', () => {
    expect(pinnedContextIds(docs, 'cards', 100_000)).toEqual(['outline', 'setting', 'notes', 'small'])
  })

  it('skips a pin that would pass the budget but keeps later ones that fit', () => {
    // 5k + 20k + 20k = 45k; notes would make 65k > 60k and is skipped; small still fits.
    expect(pinnedContextIds(docs, null)).toEqual(['outline', 'cards', 'setting', 'small'])
    expect(PINNED_CONTEXT_CHARS).toBe(60_000)
  })

  it('is empty when nothing is pinned', () => {
    expect(pinnedContextIds([{ id: 'a', chars: 10 }, { id: 'b', pinned: false, chars: 10 }], null)).toEqual([])
  })
})
