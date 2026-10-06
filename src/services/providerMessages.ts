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
 */
import type { LLMMessage } from '../types/llm'

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

// ── Anthropic ───────────────────────────────────────────────────────────────

export interface AnthropicContentPart {
  type: string
  text?: string
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

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: AnthropicContentPart[] = m.content ? [{ type: 'text', text: m.content }] : []
      for (const call of m.toolCalls) {
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
  | { functionCall: { name: string; args: Record<string, unknown> } }
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
        parts.push({ functionCall: { name: call.name, args: parseArguments(call.argumentsText) } })
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
