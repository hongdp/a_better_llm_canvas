import { describe, it, expect } from 'vitest'
import { freshnessMarkers, recordSeen, IN_CONTEXT, IN_CONTEXT_CHANGED, CHANGED, NOT_IN_CONTEXT, type SeenRecord } from '../freshness'
import { diffHtml } from '../../utils/diff'

const docs = (overrides: Record<string, string> = {}) => [
  { id: 'a', content: overrides.a ?? '<p>active</p>' },
  { id: 'b', content: overrides.b ?? '<p>outline v1</p>' },
  { id: 'c', content: overrides.c ?? '<p>cast</p>' }
]

describe('freshnessMarkers (D8)', () => {
  it('marks what the request carries, and nothing the model never saw', () => {
    const seen: SeenRecord = new Map()
    const markers = freshnessMarkers(docs(), 'a', ['b'], seen, 1)
    expect(markers).toEqual({ b: IN_CONTEXT })
    // The active chapter and the in-context one are now seen.
    expect([...seen.keys()].sort()).toEqual(['a', 'b'])
  })

  it('says a chapter left the context, and whether it changed since', () => {
    const seen: SeenRecord = new Map()
    recordSeen(seen, 'b', '<p>outline v1</p>', 1)
    recordSeen(seen, 'c', '<p>cast</p>', 1)
    const markers = freshnessMarkers(docs({ b: '<p>outline v2</p>' }), 'a', [], seen, 2)
    expect(markers).toEqual({ b: CHANGED, c: NOT_IN_CONTEXT })
  })

  it('treats accepting a pending diff as no change, and rejecting it as a change', () => {
    const seen: SeenRecord = new Map()
    // The model wrote v2; the store holds the diff awaiting review.
    recordSeen(seen, 'b', diffHtml('<p>outline v1</p>', '<p>outline v2</p>'), 1)
    expect(freshnessMarkers(docs({ b: '<p>outline v2</p>' }), 'a', [], seen, 2)).toEqual({ b: NOT_IN_CONTEXT })

    const seen2: SeenRecord = new Map()
    recordSeen(seen2, 'b', diffHtml('<p>outline v1</p>', '<p>outline v2</p>'), 1)
    expect(freshnessMarkers(docs({ b: '<p>outline v1</p>' }), 'a', [], seen2, 2)).toEqual({ b: CHANGED })
  })

  it('cannot hash a chapter that has not loaded, and does not claim it changed', () => {
    const seen: SeenRecord = new Map()
    recordSeen(seen, 'b', '<p>outline v1</p>', 1)
    const lazy = [{ id: 'a', content: '<p>x</p>' }, { id: 'b', content: '', contentLoaded: false }]
    expect(freshnessMarkers(lazy, 'a', [], seen, 2)).toEqual({ b: NOT_IN_CONTEXT })
  })
})

describe('a chapter in context that changed since the model saw it', () => {
  it('says so, because having the new text is not the same as knowing it is new', () => {
    // The reported case: the outline sat in the ledger, the user revised it,
    // the ledger re-sent it — and the model, planning from its own earlier
    // replies, never noticed.
    const seen: SeenRecord = new Map()
    recordSeen(seen, 'b', '<p>outline v1</p>', 1)
    const markers = freshnessMarkers(docs({ b: '<p>outline v2</p>' }), 'a', ['b', 'c'], seen, 2)
    expect(markers).toEqual({ b: IN_CONTEXT_CHANGED, c: IN_CONTEXT })
    // Seen now: next turn it is plain "in context" again.
    expect(freshnessMarkers(docs({ b: '<p>outline v2</p>' }), 'a', ['b', 'c'], seen, 3)).toEqual({ b: IN_CONTEXT, c: IN_CONTEXT })
  })
})
