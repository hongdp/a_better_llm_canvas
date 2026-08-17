import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAppStore } from '../../store/useAppStore'

const streamLLM = vi.fn()
vi.mock('../llm', () => ({ streamLLM: (...args: unknown[]) => streamLLM(...args) }))

// Static import on purpose: vi.resetModules() would give the service its own
// copy of the store module and it would read state this test never wrote.
import { enqueueSummaryRefresh, subscribeSummaryQueue } from '../chapterSummaries'
import type { SummaryQueueStatus } from '../chapterSummaries'

const chapter = (id: string) => ({
  id,
  title: id,
  content: '<p>' + '章'.repeat(1500) + '</p>',
  createdAt: '',
  updatedAt: ''
})

/** Resolves the pending streamLLM call, letting one summary finish. */
let release: Array<() => void> = []

beforeEach(() => {
  release = []
  streamLLM.mockReset()
  streamLLM.mockImplementation((_m, _c, callbacks: { onDone: (t: string) => void }) =>
    new Promise<void>(resolve => {
      release.push(() => { callbacks.onDone('summary text'); resolve() })
    })
  )
  useAppStore.setState({
    isStreaming: false,
    activeProvider: 'grok',
    summaryProvider: 'active',
    documents: [chapter('doc-1'), chapter('doc-2')] as never
  })
})

afterEach(() => vi.restoreAllMocks())

const tick = () => new Promise(r => setTimeout(r, 20))

describe('summary queue', () => {
  it('accepts a second chapter while the first is still running', async () => {
    const seen: SummaryQueueStatus[] = []
    const unsubscribe = subscribeSummaryQueue(s => seen.push({ ...s }))

    enqueueSummaryRefresh('doc-1', true)
    await tick()
    expect(streamLLM).toHaveBeenCalledTimes(1)

    // Queue a second one mid-flight — the case that looked stuck in the UI.
    enqueueSummaryRefresh('doc-2', true)
    await tick()

    release.shift()!()          // first finishes
    await tick()
    expect(streamLLM).toHaveBeenCalledTimes(2)

    release.shift()!()          // second finishes
    await tick()

    const final = seen.at(-1)!
    expect(final.pending).toBe(0)
    expect(final.running).toBe(false)
    unsubscribe()
  })

  it('does not leave the status strip claiming work is left', async () => {
    // "Summarizing… 1 done, 1 left" outliving the run is the reported symptom.
    const seen: SummaryQueueStatus[] = []
    const unsubscribe = subscribeSummaryQueue(s => seen.push({ ...s }))

    enqueueSummaryRefresh('doc-1', true)
    await tick()
    release.shift()!()
    await tick()

    const final = seen.at(-1)!
    expect({ pending: final.pending, running: final.running }).toEqual({ pending: 0, running: false })
    unsubscribe()
  })

  it('reports waiting-for-chat as its own state, keeping the done count', async () => {
    // A paused queue shown as "Summarizing…" reads as wedged for the whole
    // length of a chat generation; and the defer retry used to reset the
    // done counter to zero on re-entry.
    const seen: SummaryQueueStatus[] = []
    const unsubscribe = subscribeSummaryQueue(s => seen.push({ ...s }))

    enqueueSummaryRefresh('doc-1', true)
    await tick()
    release.shift()!()          // first completes: 1 done
    await tick()

    useAppStore.setState({ isStreaming: true })
    enqueueSummaryRefresh('doc-2', true)
    await tick()

    const waiting = seen.at(-1)!
    expect(waiting.waitingForChat).toBe(true)
    expect(waiting.pending).toBe(1)

    useAppStore.setState({ isStreaming: false })
    unsubscribe()
  })
})
