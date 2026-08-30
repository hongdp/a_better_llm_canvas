import { describe, it, expect } from 'vitest'
import {
  EMPTY_LEDGER,
  hashContent,
  planLedgerTurn,
  planKeepingRemoved,
  orderAdmissionsForSwitchCost,
  type ContextLedger,
  type LedgerDocLike
} from '../contextLedger'

/** A book of chapters a..e, 1000 chars each unless overridden. */
const makeDocs = (overrides: Record<string, string> = {}): LedgerDocLike[] =>
  ['a', 'b', 'c', 'd', 'e'].map(id => {
    const body = overrides[id] ?? `${id}-original`
    return { id, chars: overrides[id] ? body.length : 1000, hash: hashContent(body) }
  })

const ledgerOf = (ids: string[], docs: LedgerDocLike[]): ContextLedger => ({
  entries: ids.map(id => {
    const d = docs.find(x => x.id === id)!
    return { id, hash: d.hash, chars: d.chars }
  })
})

const ids = (l: ContextLedger) => l.entries.map(e => e.id)

describe('planLedgerTurn — the append-only invariant', () => {
  it('appends a new chapter without disturbing what was already sent', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b'], docs)

    const plan = planLedgerTurn(before, ['a', 'b', 'c'], docs, null)

    expect(ids(plan.ledger)).toEqual(['a', 'b', 'c'])
    expect(plan.cachedPrefixCount).toBe(2)
    expect(plan.appendedIds).toEqual(['c'])
    expect(plan.resentIds).toEqual([])
    expect(plan.resendChars).toBe(1000)
  })

  it('ignores the order the selector asks for — position is insertion order', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c'], docs)

    // The scorer ranked them c, a, b this turn. That must change nothing.
    const plan = planLedgerTurn(before, ['c', 'a', 'b'], docs, null)

    expect(ids(plan.ledger)).toEqual(['a', 'b', 'c'])
    expect(plan.cachedPrefixCount).toBe(3)
    expect(plan.resendChars).toBe(0)
  })

  it('is a no-op when nothing changed', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c'], docs)

    const plan = planLedgerTurn(before, ['a', 'b', 'c'], docs, null)

    expect(plan.cachedPrefixCount).toBe(3)
    expect(plan.cachedPrefixChars).toBe(3000)
    expect(plan.resendChars).toBe(0)
    expect(plan.drops).toEqual([])
    expect(plan.requiresConsent).toBe(false)
  })
})

describe('planLedgerTurn — switching the active document', () => {
  it('keeps the whole prefix when the new active chapter was last', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c'], docs)

    const plan = planLedgerTurn(before, ['a', 'b'], docs, 'c')

    expect(ids(plan.ledger)).toEqual(['a', 'b'])
    expect(plan.cachedPrefixCount).toBe(2)
    expect(plan.resendChars).toBe(0)
    expect(plan.drops).toEqual([{ id: 'c', reason: 'now-active' }])
    // Not a choice the user can reconsider — no consent panel.
    expect(plan.requiresConsent).toBe(false)
  })

  it('re-sends only the suffix when the new active chapter was in the middle', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c', 'd', 'e'], docs)

    const plan = planLedgerTurn(before, ['a', 'b', 'd', 'e'], docs, 'c')

    expect(ids(plan.ledger)).toEqual(['a', 'b', 'd', 'e'])
    expect(plan.cachedPrefixCount).toBe(2)      // a, b survive in place
    expect(plan.resentIds).toEqual(['d', 'e'])  // shifted up, must be prefilled
    expect(plan.resendChars).toBe(2000)
    expect(plan.drops).toEqual([{ id: 'c', reason: 'now-active' }])
  })

  it('never leaves a stale copy of the chapter now being edited', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c'], docs)

    // Even if the selector still asks for it, the active document belongs to
    // the volatile tail alone — two copies is how an <edit> SEARCH goes stale.
    const plan = planLedgerTurn(before, ['a', 'b', 'c'], docs, 'b')

    expect(ids(plan.ledger)).not.toContain('b')
  })

  it('re-admits the chapter the writer just left, at the end', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c'], docs)

    // Was editing 'x' (not in the ledger), switches to 'c', and now the old
    // active chapter is a reference candidate.
    const plan = planLedgerTurn(before, ['a', 'b', 'x'], [...docs, { id: 'x', chars: 500, hash: hashContent('x') }], 'c')

    expect(ids(plan.ledger)).toEqual(['a', 'b', 'x'])
    expect(plan.appendedIds).toEqual(['x'])
    expect(plan.cachedPrefixCount).toBe(2)
  })
})

describe('planLedgerTurn — an edited chapter invalidates from its position', () => {
  it('re-sends the edited chapter and everything after it', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c'], docs)
    const edited = makeDocs({ b: 'b-rewritten-by-the-user' })

    const plan = planLedgerTurn(before, ['a', 'b', 'c'], edited, null)

    // 'b' leaves its old position and re-enters at the end, so everything
    // before it stays cached and only the suffix is prefilled again.
    expect(ids(plan.ledger)).toEqual(['a', 'c', 'b'])
    expect(plan.cachedPrefixCount).toBe(1)          // only 'a' survives
    expect(plan.drops).toEqual([{ id: 'b', reason: 'edited' }])
    expect(plan.appendedIds).toEqual(['b'])
    expect(plan.resentIds).toEqual(['c'])
    expect(plan.requiresConsent).toBe(false)
  })
})

describe('planLedgerTurn — user removal needs consent', () => {
  it('flags a user removal that costs cached chapters', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c'], docs)

    const plan = planLedgerTurn(before, ['a', 'c'], docs, null)

    expect(plan.requiresConsent).toBe(true)
    expect(plan.drops).toEqual([{ id: 'b', reason: 'user-removed' }])
    expect(plan.cachedPrefixCount).toBe(1)
    expect(plan.resentIds).toEqual(['c'])
    expect(plan.resendChars).toBe(1000)
  })

  it('planKeepingRemoved preserves the whole prefix instead', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c'], docs)

    const plan = planKeepingRemoved(before, ['a', 'c'], docs, null)

    expect(ids(plan.ledger)).toEqual(['a', 'b', 'c'])
    expect(plan.cachedPrefixCount).toBe(3)
    expect(plan.resendChars).toBe(0)
    expect(plan.requiresConsent).toBe(false)
  })

  it('treats a chapter deleted from the book as a removal, not a crash', () => {
    const docs = makeDocs()
    const before = ledgerOf(['a', 'b', 'c'], docs)
    const withoutB = docs.filter(d => d.id !== 'b')

    const plan = planLedgerTurn(before, ['a', 'c'], withoutB, null)

    expect(ids(plan.ledger)).toEqual(['a', 'c'])
    expect(plan.drops).toEqual([{ id: 'b', reason: 'user-removed' }])
  })
})

describe('planLedgerTurn — starting from nothing', () => {
  it('appends the first turn in the order the selector asked for', () => {
    const docs = makeDocs()

    const plan = planLedgerTurn(EMPTY_LEDGER, ['c', 'a'], docs, 'b')

    expect(ids(plan.ledger)).toEqual(['c', 'a'])
    expect(plan.cachedPrefixCount).toBe(0)
    expect(plan.appendedIds).toEqual(['c', 'a'])
  })

  it('never admits the active document itself', () => {
    const docs = makeDocs()

    const plan = planLedgerTurn(EMPTY_LEDGER, ['a', 'b'], docs, 'a')

    expect(ids(plan.ledger)).toEqual(['b'])
  })
})

describe('hashContent', () => {
  it('separates content that differs only in length', () => {
    expect(hashContent('abc')).not.toBe(hashContent('abcd'))
  })

  it('is stable for identical input', () => {
    expect(hashContent('第一章 风雪')).toBe(hashContent('第一章 风雪'))
  })

  it('changes when a single character changes', () => {
    expect(hashContent('第一章 风雪')).not.toBe(hashContent('第一章 风霜'))
  })
})

describe('orderAdmissionsForSwitchCost', () => {
  it('appends the chapters nearest the active one last', () => {
    const book = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5']

    // Active is ch3; ch2/ch4 are the likeliest next edits, so they go last and
    // a switch to them truncates the least.
    expect(orderAdmissionsForSwitchCost(['ch2', 'ch5', 'ch4'], book, 'ch3'))
      .toEqual(['ch5', 'ch2', 'ch4'])
  })

  it('leaves the order alone when the active document is not in the book', () => {
    const book = ['ch1', 'ch2']
    expect(orderAdmissionsForSwitchCost(['ch2', 'ch1'], book, null)).toEqual(['ch2', 'ch1'])
  })
})
