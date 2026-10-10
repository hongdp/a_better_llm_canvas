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

/** Any tool, as the provider adapters see it: a name, a description, a schema. */
export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export interface DocumentTool extends ToolSpec {
  name: DocumentToolName
}

/**
 * Note what is NOT here: a "declare whether you changed the document" tool.
 * Calling a tool IS that declaration, structurally — which is why the
 * `<doc_status>` line and its three failure modes can retire for any provider
 * that supports tools.
 */
/**
 * Which chapter a write targets (agentic loop, spec D2). Listed FIRST so it
 * tends to be written before `html`: the live preview can only be routed to
 * the right chapter once it knows which one that is.
 */
const CHAPTER_PARAM: JsonSchema = {
  type: 'string',
  description:
    'Optional. The chapter to change: its number in the CHAPTER INDEX (e.g. "3") or its exact title. Omit to change the active chapter. Write this argument first.'
}

export const DOCUMENT_TOOLS: DocumentTool[] = [
  {
    name: 'update_document',
    description:
      'Replace the entire text of a chapter (the active one unless `chapter` names another), or write a new chapter (`new_chapter`). Use for a brand-new chapter, a full rewrite, or restructuring where most of the text changes. For a small change to an existing chapter, prefer edit_document. To add to a chapter or bring it up to date (new entries, a timeline carried further), change only what changes with edit_paragraphs or edit_document: a rewrite that would drop much of the text is held back.',
    parameters: {
      type: 'object',
      properties: {
        chapter: CHAPTER_PARAM,
        new_chapter: {
          type: 'string',
          description:
            'Optional. To add a chapter: its title. The chapter is created at the end of the book and filled with `html` in this one call — there is no separate step for creating it. Leave out `chapter` when you set this. Write this argument first.'
        },
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
      'Change specific passages of a chapter (the active one unless `chapter` names another), leaving everything else untouched. Preferred for rewriting a sentence or paragraph, fixing wording, or inserting and removing a section. For another chapter, read its HTML with read_chapter first.',
    parameters: {
      type: 'object',
      properties: {
        chapter: CHAPTER_PARAM,
        edits: {
          type: 'array',
          description: 'One entry per separate change.',
          items: {
            type: 'object',
            properties: {
              search: {
                type: 'string',
                description:
                  'HTML copied EXACTLY from the current document — same tags, entities, punctuation. Include enough context to be unique. Any difference and the edit cannot be located.'
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

// ── Provider adapters ───────────────────────────────────────────────────────

/** OpenAI, Grok, Ollama, llama.cpp — the shape this module already uses. */
export function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/** Anthropic: same fields, `input_schema` instead of `parameters`. */
export function toAnthropicTools(tools: ToolSpec[]): unknown[] {
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
export function toGeminiTools(tools: ToolSpec[]): unknown[] {
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

/**
 * Read back the OpenAI-shaped list a request carries (`ProviderConfig.tools`).
 *
 * The Anthropic and Gemini paths used to look the requested names up in
 * DOCUMENT_TOOLS, so any tool not in that list — every tool the agentic loop
 * adds — was dropped from the request without a word. Translating whatever
 * was passed keeps the adapters ignorant of which tools exist.
 */
export function fromOpenAITools(tools: unknown[] | undefined): ToolSpec[] {
  return (tools ?? []).flatMap(entry => {
    const fn = (entry as { function?: { name?: unknown; description?: unknown; parameters?: unknown } } | null)?.function
    if (!fn || typeof fn.name !== 'string' || !fn.parameters || typeof fn.parameters !== 'object') return []
    return [{
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters as JsonSchema
    }]
  })
}
