import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAppStore } from '../../store/useAppStore'

// Summaries run on every chapter in the background. Which provider pays for
// that is a separate decision from which one you chat with — leaving them
// coupled billed a frontier model for work a local one does fine.
const streamLLM = vi.fn()
vi.mock('../llm', () => ({ streamLLM: (...args: unknown[]) => streamLLM(...args) }))

// Imported statically on purpose. vi.resetModules() would hand the service a
// SECOND copy of the store module, so it would read state this test never
// wrote — the phantom-instance trap.
import { enqueueSummaryRefresh } from '../chapterSummaries'

beforeEach(() => {
  streamLLM.mockReset()
  streamLLM.mockImplementation((_messages, _config, callbacks: { onDone: (t: string) => void }) => {
    callbacks.onDone('a summary')
    return Promise.resolve()
  })
  useAppStore.setState({
    isStreaming: false,
    activeProvider: 'grok',
    summaryProvider: 'active',
    documents: [{
      id: 'doc-1',
      title: 'Chapter 1',
      // Above MIN_CHARS_FOR_SUMMARY (1000), or the queue skips it entirely.
      content: '<p>' + '章'.repeat(1500) + '</p>',
      createdAt: '', updatedAt: ''
    } as never],
    providerConfigs: {
      ...useAppStore.getState().providerConfigs,
      grok: { apiKey: 'x', model: 'grok-4.6', baseUrl: 'https://api.x.ai/v1' },
      ollama: { apiKey: 'ollama-no-key', model: 'qwen3.8-27b-uncensored', baseUrl: 'http://127.0.0.1:8090/v1' }
    }
  })
})

afterEach(() => vi.restoreAllMocks())

const configOfLastCall = () => streamLLM.mock.calls.at(-1)?.[1] as { provider: string; model: string }

/** The queue awaits several times before it reaches streamLLM. */
const settle = () => new Promise(r => setTimeout(r, 20))

describe('chapter summaries — which provider pays', () => {
  it("follows the chat provider by default", async () => {
    enqueueSummaryRefresh('doc-1', true)
    await settle()

    expect(configOfLastCall()).toMatchObject({ provider: 'grok', model: 'grok-4.6' })
  })

  it('runs on the chosen provider instead, with its own model and endpoint', async () => {
    useAppStore.setState({ summaryProvider: 'ollama' })

    enqueueSummaryRefresh('doc-1', true)
    await settle()

    expect(configOfLastCall()).toMatchObject({
      provider: 'ollama',
      model: 'qwen3.8-27b-uncensored',
      baseUrl: 'http://127.0.0.1:8090/v1'
    })
  })

  it("still prefers that provider's cheap utility model when one is set", async () => {
    useAppStore.setState({
      summaryProvider: 'ollama',
      providerConfigs: {
        ...useAppStore.getState().providerConfigs,
        ollama: { ...useAppStore.getState().providerConfigs.ollama, summaryModel: 'qwen3-14b-uncensored:latest' }
      }
    })

    enqueueSummaryRefresh('doc-1', true)
    await settle()

    expect(configOfLastCall()).toMatchObject({ provider: 'ollama', model: 'qwen3-14b-uncensored:latest' })
  })
})
