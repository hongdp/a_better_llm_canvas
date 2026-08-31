import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../useAppStore'

// The focus-time check ("did another device write?") compares the book's
// server updated_at against the last stamp WE recorded. Document mutations
// bump the server stamp after the metadata PUT whose response used to be the
// only thing recorded — a guaranteed-stale baseline, so returning to the tab
// after any sync reloaded the whole book and threw the reader to the top of
// the chapter (user-reported). Every mutation response now carries its stamp
// and this action adopts it.
describe('adoptServerUpdatedAt', () => {
  beforeEach(() => {
    useAppStore.setState({ lastSeenServerUpdatedAt: null })
  })

  it('adopts a stamp onto an empty baseline', () => {
    useAppStore.getState().adoptServerUpdatedAt('2026-08-31T01:00:00Z')
    expect(useAppStore.getState().lastSeenServerUpdatedAt).toBe('2026-08-31T01:00:00Z')
  })

  it('keeps the max across out-of-order parallel responses', () => {
    // Doc PUTs run in parallel; responses resolve in any order. Adopting the
    // LAST one instead of the max would regress the baseline.
    const s = useAppStore.getState()
    s.adoptServerUpdatedAt('2026-08-31T01:00:05Z')
    s.adoptServerUpdatedAt('2026-08-31T01:00:02Z')
    expect(useAppStore.getState().lastSeenServerUpdatedAt).toBe('2026-08-31T01:00:05Z')
  })

  it('ignores a missing stamp (older server without the field)', () => {
    const s = useAppStore.getState()
    s.adoptServerUpdatedAt('2026-08-31T01:00:00Z')
    s.adoptServerUpdatedAt(undefined)
    s.adoptServerUpdatedAt(null)
    expect(useAppStore.getState().lastSeenServerUpdatedAt).toBe('2026-08-31T01:00:00Z')
  })
})
