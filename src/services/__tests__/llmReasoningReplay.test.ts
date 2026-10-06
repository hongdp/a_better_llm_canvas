/**
 * Reasoning artifacts through the DIRECT transport (services/llm.ts): what
 * streamAnthropic / streamGemini capture, and that what they capture comes
 * back out of the next request in the shape the provider checks.
 *
 * Anthropic with extended thinking rejects a tool-loop step whose replayed
 * assistant turn lacks its thinking blocks (or has them modified / reordered);
 * Gemini 3 rejects one whose first function call lacks its thoughtSignature.
 * Only fetch is stubbed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { streamLLM } from '../llm'
import { applyToolCallDelta, finishToolCalls, type ToolCallAccumulator } from '../../utils/toolCallStream'
import type { LLMMessage, StreamCallbacks, ThinkingBlock } from '../../types/llm'

/** A Response whose body streams `parts` one read at a time. */
function streamingResponse(parts: string[]): Response {
  let i = 0
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () =>
          i < parts.length
            ? { value: encoder.encode(parts[i++]), done: false }
            : { value: undefined, done: true }
      })
    },
    text: async () => parts.join('')
  } as unknown as Response
}

const sse = (events: unknown[]) => events.map(e => `event: x\ndata: ${JSON.stringify(e)}\n\n`)

type Delta = Parameters<NonNullable<StreamCallbacks['onToolCallDelta']>>[0]

function recorder() {
  const log: string[] = []
  const chunks: string[] = []
  const deltas: Delta[] = []
  const blocks: ThinkingBlock[] = []
  const done: string[] = []
  const errors: string[] = []
  const callbacks: StreamCallbacks = {
    onChunk: c => { chunks.push(c); log.push('chunk') },
    onDone: t => { done.push(t); log.push('done') },
    onError: e => errors.push(e.message),
    onToolCallDelta: d => { deltas.push(d); log.push('tool') },
    onThinkingBlock: b => { blocks.push(b); log.push('thinking') }
  }
  return { log, chunks, deltas, blocks, done, errors, callbacks }
}

/** What a caller does with the deltas: accumulate, then finish. */
function finish(deltas: Delta[]) {
  const acc = new Map<number, ToolCallAccumulator>()
  for (const d of deltas) {
    applyToolCallDelta(acc, {
      index: d.index,
      id: d.id,
      function: { name: d.name, arguments: d.argumentsText },
      replace: d.replace,
      signature: d.signature
    })
  }
  return finishToolCalls(acc)
}

/** Stub fetch with one response per call, recording each request body. */
function stubFetch(responses: Response[]) {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body))
    return responses.shift() ?? new Response('', { status: 500 })
  }))
  return bodies
}

afterEach(() => { vi.unstubAllGlobals() })

const THINKING: ThinkingBlock = { type: 'thinking', thinking: 'Need chapter 3 first.', signature: 'EqQBCgIYAhIM1gbc+/==' }
const REDACTED: ThinkingBlock = { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4a' }

// Shaped after the documented stream: thinking_delta events, then ONE
// signature_delta just before content_block_stop; redacted_thinking whole in
// its start event; then text and tool_use as usual.
const anthropicEvents = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need chapter ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '3 first.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM1gbc+/==' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4a' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Reading.' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_chapter', input: {} } },
  { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"chapter":' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '"3"}' } },
  { type: 'content_block_stop', index: 3 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
  { type: 'message_stop' }
]

const anthropicConfig = {
  provider: 'anthropic',
  apiKey: 'k',
  model: 'claude-sonnet-4-5',
  baseUrl: 'https://api.anthropic.test/v1',
  forceDirect: true
}

describe('streamAnthropic: thinking blocks', () => {
  it('hands over each completed block exactly, in order, before the tool call', async () => {
    // Split mid-event so a block's pieces arrive in different reads.
    const wire = sse(anthropicEvents).join('')
    stubFetch([streamingResponse([wire.slice(0, 333), wire.slice(333, 900), wire.slice(900)])])
    const rec = recorder()

    await streamLLM([{ role: 'user', content: 'go' }], anthropicConfig, rec.callbacks)

    expect(rec.errors).toEqual([])
    expect(rec.blocks).toEqual([THINKING, REDACTED])
    // Exact shapes: no stray keys reach the replay.
    expect(Object.keys(rec.blocks[0])).toEqual(['type', 'thinking', 'signature'])
    expect(Object.keys(rec.blocks[1])).toEqual(['type', 'data'])
    expect(rec.log.indexOf('thinking')).toBeLessThan(rec.log.indexOf('tool'))

    // Text and tool deltas are unaffected; thinking is never text.
    expect(rec.chunks).toEqual(['Reading.'])
    expect(rec.done).toEqual(['Reading.'])
    expect(finish(rec.deltas)).toEqual([
      { id: 'toolu_1', name: 'read_chapter', args: { chapter: '3' }, argumentsText: '{"chapter":"3"}' }
    ])
  })

  it('drops a block the stream never finished', async () => {
    stubFetch([streamingResponse(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'cut' } }
    ]))])
    const rec = recorder()

    await streamLLM([{ role: 'user', content: 'go' }], anthropicConfig, rec.callbacks)

    // Half a block (no signature) would be rejected on replay anyway.
    expect(rec.blocks).toEqual([])
  })

  it('replays what it captured: the next step sends the turn back thinking-first', async () => {
    const bodies = stubFetch([
      streamingResponse(sse(anthropicEvents)),
      streamingResponse(sse([{ type: 'message_stop' }]))
    ])
    const rec = recorder()
    const history: LLMMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }]

    await streamLLM(history, anthropicConfig, rec.callbacks)
    const calls = finish(rec.deltas)
    await streamLLM([
      ...history,
      {
        role: 'assistant',
        content: rec.done[0],
        thinking: rec.blocks,
        toolCalls: calls.map(c => ({ id: c.id!, name: c.name, argumentsText: c.argumentsText }))
      },
      { role: 'tool', toolCallId: 'toolu_1', name: 'read_chapter', content: 'chapter text', cacheHint: true }
    ], anthropicConfig, recorder().callbacks)

    const messages = bodies[1].messages as Array<{ role: string; content: unknown }>
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        THINKING,
        REDACTED,
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_chapter', input: { chapter: '3' } }
      ]
    })
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'chapter text', cache_control: { type: 'ephemeral' } }
    ])
  })
})

describe('streamGemini: thoughtSignature', () => {
  const geminiConfig = {
    provider: 'gemini',
    apiKey: 'k',
    model: 'gemini-3-pro',
    baseUrl: 'https://gemini.test/v1beta',
    forceDirect: true
  }

  // Parallel calls: per the docs only the FIRST functionCall part carries the
  // signature, as a sibling of functionCall on that part.
  const chunk = {
    candidates: [{
      content: {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_chapter', args: { chapter: '三' } }, thoughtSignature: 'CiQBVt+/sig==' },
          { functionCall: { name: 'read_chapter', args: { chapter: '四' } } }
        ]
      },
      finishReason: 'STOP'
    }]
  }

  it('passes the part signature on its call delta, one index per call', async () => {
    const raw = `[${JSON.stringify(chunk)}]`
    stubFetch([streamingResponse([raw.slice(0, 60), raw.slice(60)])])
    const rec = recorder()

    await streamLLM([{ role: 'user', content: 'go' }], geminiConfig, rec.callbacks)

    expect(rec.errors).toEqual([])
    expect(rec.deltas).toEqual([
      { index: 0, name: 'read_chapter', argumentsText: '{"chapter":"三"}', signature: 'CiQBVt+/sig==' },
      { index: 1, name: 'read_chapter', argumentsText: '{"chapter":"四"}' }
    ])
    expect('signature' in rec.deltas[1]).toBe(false)
  })

  it('replays what it captured: the signature goes back beside the first call', async () => {
    const bodies = stubFetch([
      streamingResponse([`[${JSON.stringify(chunk)}]`]),
      streamingResponse(['[]'])
    ])
    const rec = recorder()

    await streamLLM([{ role: 'user', content: 'go' }], geminiConfig, rec.callbacks)
    const calls = finish(rec.deltas)
    expect(calls.map(c => c.name)).toEqual(['read_chapter', 'read_chapter'])
    await streamLLM([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: calls.map((c, i) => ({ id: `s1_${i}`, name: c.name, argumentsText: c.argumentsText, signature: c.signature }))
      },
      { role: 'tool', toolCallId: 's1_0', name: 'read_chapter', content: 'three' },
      { role: 'tool', toolCallId: 's1_1', name: 'read_chapter', content: 'four' }
    ], geminiConfig, recorder().callbacks)

    const contents = bodies[1].contents as Array<{ role: string; parts: unknown[] }>
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { functionCall: { name: 'read_chapter', args: { chapter: '三' } }, thoughtSignature: 'CiQBVt+/sig==' },
        { functionCall: { name: 'read_chapter', args: { chapter: '四' } } }
      ]
    })
  })
})
