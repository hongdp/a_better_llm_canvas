/**
 * Chat history → each provider's message format, tool exchanges included.
 *
 * Pure, and kept apart from the streaming code so the shapes can be asserted
 * without a network. `scripts/server_generation.py` builds the same bodies for
 * the backend transport (which is the path grok takes for any logged-in user):
 * a change here needs the same change there, or a tool history sent through
 * one transport and not the other silently loses its tool results.
 *
 * Wire contract (docs/features/agentic_chat_loop.md §5.5): an assistant
 * message may carry `toolCalls`, and each result is a `tool` message naming
 * the call it answers.
 *
 * Reasoning artifacts ride along for the providers that check them on replay:
 * - Anthropic (extended thinking): the assistant turn holding `tool_use` must
 *   carry its `thinking` / `redacted_thinking` blocks complete, unmodified and
 *   in order, ahead of the text and tool_use blocks
 *   (platform.claude.com/docs/en/build-with-claude/thinking#preserving-thinking-blocks).
 * - Gemini (thinking models): a `functionCall` part may come with a sibling
 *   `thoughtSignature`, which must go back on that same part; Gemini 3 rejects
 *   a step whose first call lacks it
 *   (ai.google.dev/gemini-api/docs/generate-content/thought-signatures).
 * - grok (xAI Responses API): each reply's output items — reasoning with its
 *   `encrypted_content`, message, function_call — go back unchanged in the
 *   next step's `input`, so the model keeps its reasoning; xAI also counts
 *   omitted reasoning as the top cause of prompt-cache misses
 *   (docs.x.ai, Reasoning → Encrypted Reasoning Content).
 * OpenAI Chat Completions has no equivalent, so its shape is unchanged.
 */
import type { LLMMessage, ThinkingBlock } from '../types/llm'

const DATA_URL_RE = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/

/** A tool call's arguments as an object; providers other than OpenAI want one. */
function parseArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// ── OpenAI / grok / Ollama / llama.cpp ──────────────────────────────────────

export function toOpenAIMessages(messages: LLMMessage[]): unknown[] {
  return messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          // Byte-for-byte as received: see LLMToolCall.argumentsText.
          function: { name: call.name, arguments: call.argumentsText }
        }))
      }
    }
    if (m.images && m.images.length > 0) {
      const parts: Array<
        { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
      > = [{ type: 'text', text: m.content }]
      m.images.forEach((img, idx) => {
        parts.push({ type: 'text', text: `\n[Image ${idx + 1}]:` })
        parts.push({ type: 'image_url', image_url: { url: img } })
      })
      return { role: m.role, content: parts }
    }
    return { role: m.role, content: m.content }
  })
}

// ── grok: xAI Responses API ─────────────────────────────────────────────────

/** An assistant message's grok output items, verbatim (mirrors server_generation._response_items). */
function responseItemsOf(m: LLMMessage): unknown[] {
  if (m.role !== 'assistant' || !Array.isArray(m.responseItems)) return []
  return m.responseItems.filter(item =>
    !!item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string')
}

/**
 * History → xAI Responses `input` (mirrors server_generation.build_grok_responses_request).
 * An assistant reply that carries its output items is sent as those items,
 * unchanged; one without (an earlier turn's text) is rebuilt from its text
 * and calls. Tool results answer their call by `call_id`.
 */
export function toGrokResponsesInput(messages: LLMMessage[]): unknown[] {
  const items: unknown[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content })
      continue
    }
    if (m.role === 'assistant') {
      // Items the reply kept go back verbatim; whatever they do not cover (a
      // history message keeps only its reasoning) is rebuilt from the text
      // and calls, after them — the order the model produced them in.
      const replay = responseItemsOf(m) as Array<{ type: string; call_id?: string }>
      items.push(...replay)
      const hasMessage = replay.some(item => item.type === 'message')
      const replayedCalls = new Set(replay.filter(item => item.type === 'function_call').map(item => item.call_id))
      const calls = (m.toolCalls ?? []).filter(call => !replayedCalls.has(call.id))
      if (!hasMessage && (m.content || (calls.length === 0 && replay.length === 0))) items.push({ role: 'assistant', content: m.content })
      for (const call of calls) {
        // Byte-for-byte as received: see LLMToolCall.argumentsText.
        items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsText })
      }
      continue
    }
    if (m.images && m.images.length > 0) {
      const parts: unknown[] = [{ type: 'input_text', text: m.content }]
      m.images.forEach((img, idx) => {
        parts.push({ type: 'input_text', text: `\n[Image ${idx + 1}]:` })
        parts.push({ type: 'input_image', image_url: img })
      })
      items.push({ role: m.role, content: parts })
      continue
    }
    items.push({ role: m.role, content: m.content })
  }
  return items
}

/** OpenAI-shaped tools (`{type, function: {...}}`) → the Responses API's flat shape. */
export function toResponsesTools(tools: unknown[]): unknown[] {
  return tools.flatMap(t => {
    const fn = (t as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })?.function
    if (!fn || typeof fn.name !== 'string' || !fn.parameters || typeof fn.parameters !== 'object') return []
    return [{ type: 'function', name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', parameters: fn.parameters }]
  })
}

// ── Anthropic ───────────────────────────────────────────────────────────────

export interface AnthropicContentPart {
  type: string
  text?: string
  /** thinking blocks: the reasoning text (may be '') and its signature. */
  thinking?: string
  signature?: string
  /** redacted_thinking blocks: the encrypted payload. */
  data?: string
  source?: { type: string; media_type: string; data: string }
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  cache_control?: { type: 'ephemeral' }
}

export interface AnthropicMessage {
  role: string
  content: string | AnthropicContentPart[]
}

/**
 * Non-system messages in Anthropic's shape.
 *
 * `sourceIndex[i]` is the output message that non-system input `i` landed in.
 * The cache-breakpoint pass needs it: consecutive tool results merge into ONE
 * user message (Anthropic requires every result of a turn together), so input
 * and output indices stop lining up after the first tool exchange.
 */
/**
 * A reasoning block exactly as it streamed. Copied field by field, never
 * spread: a stray key would be rejected, and the values are opaque.
 */
function anthropicThinkingPart(block: ThinkingBlock): AnthropicContentPart {
  return block.type === 'redacted_thinking'
    ? { type: 'redacted_thinking', data: block.data }
    : { type: 'thinking', thinking: block.thinking, signature: block.signature }
}

export function toAnthropicMessages(nonSystem: LLMMessage[]): {
  messages: AnthropicMessage[]
  sourceIndex: number[]
} {
  const out: AnthropicMessage[] = []
  const sourceIndex: number[] = []

  for (const m of nonSystem) {
    if (m.role === 'tool') {
      const result: AnthropicContentPart = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const previous = out[out.length - 1]
      const previousIsResults = previous && previous.role === 'user' && Array.isArray(previous.content) &&
        previous.content.length > 0 && previous.content.every(p => p.type === 'tool_result')
      if (previousIsResults) {
        (previous.content as AnthropicContentPart[]).push(result)
      } else {
        out.push({ role: 'user', content: [result] })
      }
      sourceIndex.push(out.length - 1)
      continue
    }

    if (m.role === 'assistant' && (m.toolCalls?.length || m.thinking?.length)) {
      // Reasoning first, verbatim: Anthropic checks each block's signature
      // and their order, and manual extended thinking also requires the
      // replayed turn to BEGIN with a thinking block.
      const content: AnthropicContentPart[] = (m.thinking ?? []).map(anthropicThinkingPart)
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const call of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call.argumentsText) })
      }
      out.push({ role: 'assistant', content })
      sourceIndex.push(out.length - 1)
      continue
    }

    if (m.images && m.images.length > 0) {
      const content: AnthropicContentPart[] = [{ type: 'text', text: m.content }]
      m.images.forEach((img, idx) => {
        const match = img.match(DATA_URL_RE)
        if (match) {
          content.push({ type: 'text', text: `\n[Image ${idx + 1}]:` })
          content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
        }
      })
      out.push({ role: m.role, content })
    } else {
      out.push({ role: m.role, content: m.content })
    }
    sourceIndex.push(out.length - 1)
  }

  return { messages: out, sourceIndex }
}

// ── Gemini ──────────────────────────────────────────────────────────────────

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  // thoughtSignature is a SIBLING of functionCall on the part, not inside it.
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: { content: string } } }

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/** Non-system messages as Gemini `contents`; consecutive tool results merge. */
export function toGeminiContents(nonSystem: LLMMessage[]): GeminiContent[] {
  const out: GeminiContent[] = []

  for (const m of nonSystem) {
    if (m.role === 'tool') {
      const part: GeminiPart = { functionResponse: { name: m.name ?? '', response: { content: m.content } } }
      const previous = out[out.length - 1]
      if (previous && previous.role === 'user' && previous.parts.length > 0 &&
          previous.parts.every(p => 'functionResponse' in p)) {
        previous.parts.push(part)
      } else {
        out.push({ role: 'user', parts: [part] })
      }
      continue
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: GeminiPart[] = m.content ? [{ text: m.content }] : []
      for (const call of m.toolCalls) {
        const part: GeminiPart = { functionCall: { name: call.name, args: parseArguments(call.argumentsText) } }
        // Back on the part it came on. Only present on the first of parallel
        // calls, so the others are left without one — as Gemini sent them.
        if (call.signature) part.thoughtSignature = call.signature
        parts.push(part)
      }
      out.push({ role: 'model', parts })
      continue
    }

    const parts: GeminiPart[] = [{ text: m.content }]
    m.images?.forEach((img, idx) => {
      const match = img.match(DATA_URL_RE)
      if (match) {
        parts.push({ text: `\n[Image ${idx + 1}]:` })
        parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
      }
    })
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
  }

  return out
}
