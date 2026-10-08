import { describe, it, expect, vi, afterEach } from 'vitest'
import type { LLMMessage, ThinkingBlock } from '../../types/llm'
import { toOpenAIMessages, toAnthropicMessages, toGeminiContents, toGrokResponsesInput, toResponsesTools } from '../providerMessages'
import { fromOpenAITools, toOpenAITools, toAnthropicTools, toGeminiTools, type ToolSpec } from '../../utils/documentTools'

// Arguments with unusual spacing: a replay must carry these bytes unchanged,
// because grok's prompt cache matches the exact prefix.
const ARGS = '{"chapter":  "第三章", "format":"html"}'

const toolHistory: LLMMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'read chapter 3 and 4' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call_1', name: 'read_chapter', argumentsText: ARGS },
      { id: 'call_2', name: 'read_chapter', argumentsText: '{"chapter":"第四章"}' }
    ]
  },
  { role: 'tool', toolCallId: 'call_1', name: 'read_chapter', content: 'text of 3' },
  { role: 'tool', toolCallId: 'call_2', name: 'read_chapter', content: 'text of 4' },
  { role: 'user', content: 'now edit', cacheHint: true }
]

describe('toOpenAIMessages', () => {
  it('replays tool calls with their argument bytes untouched, and results by call id', () => {
    const out = toOpenAIMessages(toolHistory) as Array<Record<string, unknown>>
    expect(out[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_chapter', arguments: ARGS } },
        { id: 'call_2', type: 'function', function: { name: 'read_chapter', arguments: '{"chapter":"第四章"}' } }
      ]
    })
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'text of 3' })
    expect(out[5]).toEqual({ role: 'user', content: 'now edit' })
  })

  it('keeps text that came with a tool call', () => {
    const out = toOpenAIMessages([
      { role: 'assistant', content: 'Let me look.', toolCalls: [{ id: 'a', name: 'list_chapters', argumentsText: '{}' }] }
    ]) as Array<Record<string, unknown>>
    expect(out[0].content).toBe('Let me look.')
  })

  it('leaves plain and image messages as they were', () => {
    const out = toOpenAIMessages([
      { role: 'user', content: 'hi', images: ['data:image/png;base64,AAAA'] },
      { role: 'assistant', content: 'hello' }
    ]) as Array<Record<string, unknown>>
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'text', text: '\n[Image 1]:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
      ]
    })
    expect(out[1]).toEqual({ role: 'assistant', content: 'hello' })
  })
})

describe('toAnthropicMessages', () => {
  const nonSystem = toolHistory.filter(m => m.role !== 'system')

  it('sends calls as tool_use blocks and merges consecutive results into one user turn', () => {
    const { messages } = toAnthropicMessages(nonSystem)
    expect(messages).toHaveLength(4)
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'read_chapter', input: { chapter: '第三章', format: 'html' } },
        { type: 'tool_use', id: 'call_2', name: 'read_chapter', input: { chapter: '第四章' } }
      ]
    })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'text of 3' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'text of 4' }
      ]
    })
  })

  it('maps every input message to the output message that holds it', () => {
    const { sourceIndex } = toAnthropicMessages(nonSystem)
    // user, assistant, tool, tool (merged), user
    expect(sourceIndex).toEqual([0, 1, 2, 2, 3])
  })

  it('treats unparseable arguments as an empty input rather than throwing', () => {
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: 'x', toolCalls: [{ id: 'c', name: 'n', argumentsText: '{"cut off' }] }
    ])
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'x' },
      { type: 'tool_use', id: 'c', name: 'n', input: {} }
    ])
  })
})

describe('toGeminiContents', () => {
  it('sends calls as functionCall parts and merges results into one user turn', () => {
    const contents = toGeminiContents(toolHistory.filter(m => m.role !== 'system'))
    expect(contents).toHaveLength(4)
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { functionCall: { name: 'read_chapter', args: { chapter: '第三章', format: 'html' } } },
        { functionCall: { name: 'read_chapter', args: { chapter: '第四章' } } }
      ]
    })
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'read_chapter', response: { content: 'text of 3' } } },
        { functionResponse: { name: 'read_chapter', response: { content: 'text of 4' } } }
      ]
    })
  })
})

// Reasoning artifacts the providers check on replay. Anthropic: the tool_use
// turn comes back with its thinking blocks complete, unmodified, in order,
// FIRST. Gemini: a call's thoughtSignature comes back beside its functionCall.
describe('reasoning artifacts on replay', () => {
  const THINKING: ThinkingBlock = { type: 'thinking', thinking: 'Need chapter 3 first.', signature: 'EqQBCgIYAhIM1gbc+/==' }
  const REDACTED: ThinkingBlock = { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4a' }

  const withArtifacts = (): LLMMessage[] => toolHistory
    .filter(m => m.role !== 'system')
    .map(m => m.role === 'assistant'
      ? {
          ...m,
          content: 'Reading it first.',
          thinking: [THINKING, REDACTED],
          // Parallel calls: only the FIRST carries a signature.
          toolCalls: m.toolCalls!.map((c, i) => i === 0 ? { ...c, signature: 'CiQBVt+/sig==' } : c)
        }
      : m)

  it('anthropic: thinking blocks first and verbatim, then text, then tool_use', () => {
    const { messages } = toAnthropicMessages(withArtifacts())
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Need chapter 3 first.', signature: 'EqQBCgIYAhIM1gbc+/==' },
        { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4a' },
        { type: 'text', text: 'Reading it first.' },
        { type: 'tool_use', id: 'call_1', name: 'read_chapter', input: { chapter: '第三章', format: 'html' } },
        { type: 'tool_use', id: 'call_2', name: 'read_chapter', input: { chapter: '第四章' } }
      ]
    })
  })

  it('anthropic: an omitted-display block (empty thinking) still goes back, with no stray keys', () => {
    const omitted = { type: 'thinking', thinking: '', signature: 'sig', extra: 'x' } as unknown as ThinkingBlock
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', thinking: [omitted], toolCalls: [{ id: 'a', name: 'list_chapters', argumentsText: '{}' }] }
    ])
    expect(messages[1].content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'a', name: 'list_chapters', input: {} }
    ])
    expect(Object.keys((messages[1].content as object[])[0])).toEqual(['type', 'thinking', 'signature'])
  })

  it('gemini: thoughtSignature sits beside the functionCall of the call that had it', () => {
    const contents = toGeminiContents(withArtifacts())
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Reading it first.' },
        {
          functionCall: { name: 'read_chapter', args: { chapter: '第三章', format: 'html' } },
          thoughtSignature: 'CiQBVt+/sig=='
        },
        { functionCall: { name: 'read_chapter', args: { chapter: '第四章' } } }
      ]
    })
  })

  it('openai: no equivalent, so neither artifact leaks into the request', () => {
    const out = toOpenAIMessages(withArtifacts()) as Array<Record<string, unknown>>
    expect(Object.keys(out[1]).sort()).toEqual(['content', 'role', 'tool_calls'])
    const calls = out[1].tool_calls as Array<Record<string, unknown>>
    expect(Object.keys(calls[0]).sort()).toEqual(['function', 'id', 'type'])
  })
})

describe('fromOpenAITools', () => {
  const custom: ToolSpec = {
    name: 'read_chapter',
    description: 'Read one chapter.',
    parameters: { type: 'object', properties: { chapter: { type: 'string' } }, required: ['chapter'] }
  }

  it('round-trips any tool, not only the document tools', () => {
    expect(fromOpenAITools(toOpenAITools([custom]))).toEqual([custom])
  })

  it('skips entries that are not functions', () => {
    expect(fromOpenAITools([{ type: 'function' }, null, 'x', { function: { name: 'n' } }])).toEqual([])
  })

  it('reaches the Anthropic and Gemini shapes with the custom tool intact', () => {
    const specs = fromOpenAITools(toOpenAITools([custom]))
    expect(toAnthropicTools(specs)).toEqual([
      { name: 'read_chapter', description: 'Read one chapter.', input_schema: custom.parameters }
    ])
    expect(toGeminiTools(specs)).toEqual([{
      functionDeclarations: [{
        name: 'read_chapter',
        description: 'Read one chapter.',
        parameters: { type: 'OBJECT', properties: { chapter: { type: 'STRING' } }, required: ['chapter'] }
      }]
    }])
  })
})

// The request bodies themselves, through the real stream functions: this is
// where the old name filter dropped every tool it did not know.
describe('streamLLM request bodies', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const captureBody = async (provider: string) => {
    let body: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body)
      return new Response('', { status: 500 })
    }))
    const { streamLLM } = await import('../llm')
    await streamLLM(toolHistory, {
      provider,
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://example.test',
      forceDirect: true,
      tools: toOpenAITools([{
        name: 'read_chapter',
        description: 'Read one chapter.',
        parameters: { type: 'object', properties: { chapter: { type: 'string' } } }
      }])
    }, { onChunk: () => {}, onDone: () => {}, onError: () => {} })
    return body as unknown as Record<string, unknown>
  }

  it('anthropic: sends an unknown tool and lands the cache hint after merged results', async () => {
    const body = await captureBody('anthropic')
    expect((body.tools as Array<{ name: string }>).map(t => t.name)).toEqual(['read_chapter'])
    const messages = body.messages as Array<{ content: unknown }>
    // The final user message carries the hint; without the index map it
    // would have been looked up one position too far and skipped.
    expect(messages[3].content).toEqual([{ type: 'text', text: 'now edit', cache_control: { type: 'ephemeral' } }])
  })

  it('gemini: sends an unknown tool', async () => {
    const body = await captureBody('gemini')
    const declarations = (body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0].functionDeclarations
    expect(declarations.map(d => d.name)).toEqual(['read_chapter'])
  })

  it('grok: goes over the xAI Responses API, the tool exchange as items', async () => {
    const body = await captureBody('grok')
    const input = body.input as Array<Record<string, unknown>>
    expect(input[4]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'text of 3' })
    expect(body).toMatchObject({ store: false, include: ['reasoning.encrypted_content'], stream: true })
    expect(body.tools).toEqual([{ type: 'function', name: 'read_chapter', description: 'Read one chapter.', parameters: { type: 'object', properties: { chapter: { type: 'string' } } } }])
  })
})

describe('toGrokResponsesInput (xAI Responses API)', () => {
  const REASONING = { id: 'rs_1', summary: [], type: 'reasoning', status: 'completed', encrypted_content: 'CIPHER==' }
  const CALL = { arguments: ARGS, call_id: 'call_1', name: 'read_chapter', type: 'function_call', id: 'fc_1', status: 'completed' }

  it('sends a reply that kept its output items as exactly those items, reasoning first', () => {
    const history: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_chapter', argumentsText: ARGS }], responseItems: [REASONING, CALL] },
      { role: 'tool', toolCallId: 'call_1', name: 'read_chapter', content: 'text of 3' }
    ]
    expect(toGrokResponsesInput(history)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      REASONING,
      CALL,
      { type: 'function_call_output', call_id: 'call_1', output: 'text of 3' }
    ])
  })

  it('rebuilds a reply without items from its text and calls, arguments byte for byte', () => {
    const out = toGrokResponsesInput(toolHistory) as Array<Record<string, unknown>>
    expect(out[2]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'read_chapter', arguments: ARGS })
    expect(out[3]).toEqual({ type: 'function_call', call_id: 'call_2', name: 'read_chapter', arguments: '{"chapter":"第四章"}' })
    expect(toGrokResponsesInput([{ role: 'assistant', content: '好的。' }])).toEqual([{ role: 'assistant', content: '好的。' }])
  })

  it('replays a history message\'s reasoning items, then its text — a hidden decision carries across turns (measured 2026-10-08)', () => {
    const out = toGrokResponsesInput([
      { role: 'user', content: 'pick a fruit' },
      { role: 'assistant', content: 'Ready.', responseItems: [REASONING] },
      { role: 'user', content: 'which?' }
    ])
    expect(out).toEqual([{ role: 'user', content: 'pick a fruit' }, REASONING, { role: 'assistant', content: 'Ready.' }, { role: 'user', content: 'which?' }])
  })

  it('sends images as input_image parts', () => {
    expect(toGrokResponsesInput([{ role: 'user', content: '看', images: ['data:image/png;base64,AAA'] }])).toEqual([{
      role: 'user',
      content: [{ type: 'input_text', text: '看' }, { type: 'input_text', text: '\n[Image 1]:' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }]
    }])
  })

  it('flattens OpenAI-shaped tools', () => {
    expect(toResponsesTools(toOpenAITools([{ name: 'grep', description: 'd', parameters: { type: 'object' } }]))).toEqual([
      { type: 'function', name: 'grep', description: 'd', parameters: { type: 'object' } }
    ])
  })
})

describe('streamLLM over the xAI Responses API (direct transport)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('streams text, reasoning and calls, and hands over every output item', async () => {
    const REASONING = { id: 'rs_1', summary: [], type: 'reasoning', status: 'completed', encrypted_content: 'CIPHER==' }
    const CALL = { arguments: '{"chapter":2}', call_id: 'call-1', name: 'read_chapter', type: 'function_call', id: 'fc_1', status: 'completed' }
    const events = [
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '先读。' },
      { type: 'response.output_item.done', output_index: 0, item: REASONING },
      { type: 'response.output_text.delta', output_index: 1, delta: '好的。' },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call-1', name: 'read_chapter', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"chapter":2}' },
      { type: 'response.output_item.done', output_index: 2, item: CALL },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 90 } } } }
    ]
    const sse = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200 })))
    const { streamLLM } = await import('../llm')
    const got = { chunks: '', reasoning: '', items: [] as unknown[], deltas: [] as unknown[], done: null as null | { text: string; usage: unknown } }
    await streamLLM([{ role: 'user', content: 'q' }], { provider: 'grok', apiKey: 'k', model: 'grok-4.7', baseUrl: 'https://api.x.ai/v1', forceDirect: true }, {
      onChunk: c => { got.chunks += c },
      onReasoning: r => { got.reasoning += r },
      onResponseItem: item => { got.items.push(item) },
      onToolCallDelta: d => { got.deltas.push(d) },
      onDone: (text, usage) => { got.done = { text, usage } },
      onError: e => { throw e }
    })
    expect(got.chunks).toBe('好的。')
    expect(got.reasoning).toBe('先读。')
    expect(got.items).toEqual([REASONING, CALL])
    expect(got.deltas[0]).toEqual({ index: 2, id: 'call-1', name: 'read_chapter', argumentsText: '' })
    expect(got.deltas.at(-1)).toMatchObject({ index: 2, argumentsText: '{"chapter":2}', replace: true })
    expect(got.done).toEqual({ text: '好的。', usage: { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 90 } })
  })

  it('retries once without the replayed reasoning when xAI cannot decrypt it', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      if (bodies.length === 1) return new Response('{"code":"invalid-argument","error":"Could not decrypt the provided encrypted_content."}', { status: 400 })
      return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'ok' })}\n\ndata: [DONE]\n\n`, { status: 200 })
    }))
    const { streamLLM } = await import('../llm')
    let done = ''
    await streamLLM([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', responseItems: [{ type: 'reasoning', id: 'rs', encrypted_content: 'stale' }] },
      { role: 'user', content: 'q2' }
    ], { provider: 'grok', apiKey: 'k', model: 'grok-4.7', baseUrl: 'https://api.x.ai/v1', forceDirect: true }, {
      onChunk: () => {}, onDone: t => { done = t }, onError: e => { throw e }
    })
    expect(bodies).toHaveLength(2)
    expect(JSON.stringify(bodies[0].input)).toContain('stale')
    expect(JSON.stringify(bodies[1].input)).not.toContain('stale')
    expect(done).toBe('ok')
  })

  it('reports a failed response as an error', async () => {
    const sse = `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'boom' } } })}\n\n`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200 })))
    const { streamLLM } = await import('../llm')
    let error: Error | null = null
    await streamLLM([{ role: 'user', content: 'q' }], { provider: 'grok', apiKey: 'k', model: 'grok-4.7', baseUrl: 'https://api.x.ai/v1', forceDirect: true }, {
      onChunk: () => {}, onDone: () => {}, onError: e => { error = e }
    })
    expect(String(error)).toContain('boom')
  })
})

describe('toolChoice "none" (the run\'s final step)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const bodyFor = async (provider: string) => {
    let body: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body)
      return new Response('', { status: 500 })
    }))
    const { streamLLM } = await import('../llm')
    await streamLLM([{ role: 'user', content: 'hi' }], {
      provider, apiKey: 'k', model: 'm', baseUrl: 'https://example.test', forceDirect: true,
      toolChoice: 'none',
      tools: toOpenAITools([{ name: 'read_chapter', description: 'd', parameters: { type: 'object' } }])
    }, { onChunk: () => {}, onDone: () => {}, onError: () => {} })
    return body as unknown as Record<string, unknown>
  }

  it('keeps the tools but forbids a new call, in each provider\'s spelling', async () => {
    const grok = await bodyFor('grok')
    expect(grok.tool_choice).toBe('none')
    expect(grok.tools).toBeDefined()
    expect((await bodyFor('anthropic')).tool_choice).toEqual({ type: 'none' })
    expect((await bodyFor('gemini')).toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } })
  })
})
