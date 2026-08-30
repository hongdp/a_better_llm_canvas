import type { ParsedAssistantResponse, EditBlock } from './text'

/**
 * The document tools, in one internal shape, with adapters per provider.
 *
 * Why this replaces the Canvas Markup Protocol: the old scheme asked every
 * model to learn a private tag language (`<canvas>`, `<edit>`, …). Frontier
 * models managed it; smaller ones did not. Measured on a local Qwen3-14B: with
 * the tag protocol it expanded a paragraph and emitted bare `<p>` HTML, so
 * NOTHING reached the document, every time. Given the same task as an OpenAI
 * function call it produced a correct `tool_calls` response on the first
 * attempt — because that format is in its training data and ours is not.
 *
 * OpenAI's function-calling shape is the internal representation because four
 * of the five providers speak it directly (OpenAI, Grok, Ollama, llama.cpp).
 * Anthropic and Gemini get thin adapters below rather than their own protocol.
 */

export type DocumentToolName =
  | 'update_document'
  | 'edit_document'
  | 'replace_selection'

export interface JsonSchema {
  type: string
  description?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
}

export interface DocumentTool {
  name: DocumentToolName
  description: string
  parameters: JsonSchema
}

/**
 * Note what is NOT here: a "declare whether you changed the document" tool.
 * Calling a tool IS that declaration, structurally — which is why the
 * `<doc_status>` line and its three failure modes can retire for any provider
 * that supports tools.
 */
export const DOCUMENT_TOOLS: DocumentTool[] = [
  {
    name: 'update_document',
    description:
      'Replace the entire active document. Use for a brand-new document, a full rewrite, or restructuring where most of the text changes. For a small change to an existing document, prefer edit_document.',
    parameters: {
      type: 'object',
      properties: {
        html: {
          type: 'string',
          description:
            'The COMPLETE new document as an HTML fragment: <h1>, <p>, <blockquote>, <strong>, <em>, <ul>/<ol>/<li>. No <!DOCTYPE>, <html>, <head> or <body>. Never abbreviate with placeholders like "<!-- unchanged -->". Copy every {{IMAGE_PLACEHOLDER_n}} token exactly, in place.'
        }
      },
      required: ['html']
    }
  },
  {
    name: 'edit_document',
    description:
      'Change specific passages of the active document, leaving everything else untouched. Preferred for rewriting a sentence or paragraph, fixing wording, or inserting and removing a section.',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'One entry per separate change.',
          items: {
            type: 'object',
            properties: {
              search: {
                type: 'string',
                description:
                  'HTML copied EXACTLY from the current document — same tags, entities, punctuation. Start at a block boundary and include enough context to be unique. Any difference and the edit cannot be located.'
              },
              replace: {
                type: 'string',
                description: 'The HTML that replaces it. Empty string deletes the passage.'
              }
            },
            required: ['search', 'replace']
          }
        }
      },
      required: ['edits']
    }
  },
  {
    name: 'replace_selection',
    description:
      'Rewrite ONLY the text the user currently has selected. Available when the request includes a CURRENT SELECTED TEXT section; do not use it otherwise.',
    parameters: {
      type: 'object',
      properties: {
        html: {
          type: 'string',
          description:
            'The replacement for the selected passage only, as HTML. Do not include the surrounding text.'
        }
      },
      required: ['html']
    }
  }
]

/** The tools a turn should offer, given what the turn can actually use. */
export function toolsForTurn(options: {
  hasSelection: boolean
}): DocumentTool[] {
  return DOCUMENT_TOOLS.filter(tool => {
    if (tool.name === 'replace_selection') return options.hasSelection
    return true
  })
}

// ── Provider adapters ───────────────────────────────────────────────────────

/** OpenAI, Grok, Ollama, llama.cpp — the shape this module already uses. */
export function toOpenAITools(tools: DocumentTool[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/** Anthropic: same fields, `input_schema` instead of `parameters`. */
export function toAnthropicTools(tools: DocumentTool[]): unknown[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))
}

/**
 * Gemini: one `functionDeclarations` array. Its schema dialect rejects the
 * unknown keys OpenAPI allows, so only the subset it accepts is passed through.
 */
export function toGeminiTools(tools: DocumentTool[]): unknown[] {
  const clean = (schema: JsonSchema): Record<string, unknown> => {
    const out: Record<string, unknown> = { type: schema.type.toUpperCase() }
    if (schema.description) out.description = schema.description
    if (schema.properties) {
      out.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([k, v]) => [k, clean(v)])
      )
    }
    if (schema.items) out.items = clean(schema.items)
    if (schema.required) out.required = schema.required
    return out
  }
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: clean(t.parameters)
    }))
  }]
}

// ── Bridge to the existing apply pipeline ───────────────────────────────────

/**
 * Present a tool call in the shape the completion path already understands.
 *
 * Everything downstream — the diff, canvas validation, image reinsertion,
 * edit-block application — was built against `ParsedAssistantResponse` and is
 * well tested. The tools change how a model EXPRESSES an edit, not what the
 * app does with it, so they are adapted here rather than duplicated there.
 */
export function toolCallToParsedResponse(
  call: { name: string; args: Record<string, unknown> | null },
  chatText: string
): ParsedAssistantResponse {
  const base: ParsedAssistantResponse = {
    kind: 'chat',
    chatText,
    selectionText: '',
    editBlocks: [],
    canvasText: '',
    canvasClosed: false
  }

  // Unparseable arguments mean the model was cut off mid-call. Reported as an
  // unclosed canvas so it takes the existing "response was truncated, nothing
  // applied" path instead of silently writing half a document.
  if (!call.args) {
    return { ...base, kind: 'canvas', canvasText: '', canvasClosed: false }
  }

  if (call.name === 'update_document') {
    const html = typeof call.args.html === 'string' ? call.args.html : ''
    return { ...base, kind: 'canvas', canvasText: html, canvasClosed: html.length > 0 }
  }

  if (call.name === 'replace_selection') {
    const html = typeof call.args.html === 'string' ? call.args.html : ''
    return { ...base, kind: 'selection', selectionText: html }
  }

  if (call.name === 'edit_document') {
    const raw = Array.isArray(call.args.edits) ? call.args.edits : []
    const editBlocks: EditBlock[] = raw
      .filter((e): e is { search: string; replace?: string } =>
        !!e && typeof e === 'object' && typeof (e as { search?: unknown }).search === 'string')
      .map(e => ({ search: e.search, replace: typeof e.replace === 'string' ? e.replace : '' }))
    return { ...base, kind: editBlocks.length > 0 ? 'edits' : 'chat', editBlocks }
  }

  return base
}
