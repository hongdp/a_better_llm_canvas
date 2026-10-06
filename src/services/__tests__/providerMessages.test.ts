import { describe, it, expect, vi, afterEach } from 'vitest'
import type { LLMMessage, ThinkingBlock } from '../../types/llm'
import { toOpenAIMessages, toAnthropicMessages, toGeminiContents } from '../providerMessages'
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

  it('grok: sends the tool exchange in OpenAI shape', async () => {
    const body = await captureBody('grok')
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'text of 3' })
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
