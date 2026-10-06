import { describe, it, expect } from 'vitest'
import {
  DOCUMENT_TOOLS,
  toOpenAITools,
  toAnthropicTools,
  toGeminiTools
} from '../documentTools'

// The tag protocol asked every model to learn a private language. A local
// Qwen3-14B never emitted <canvas> under it, and produced a correct tool call
// on the first attempt with these — the format is in its training data.
describe('provider adapters', () => {
  it('wraps OpenAI-style, which is the internal shape', () => {
    const [first] = toOpenAITools([DOCUMENT_TOOLS[0]]) as Array<{ type: string; function: { name: string; parameters: unknown } }>
    expect(first.type).toBe('function')
    expect(first.function.name).toBe('update_document')
    expect(first.function.parameters).toEqual(DOCUMENT_TOOLS[0].parameters)
  })

  it('renames parameters to input_schema for Anthropic', () => {
    const [first] = toAnthropicTools([DOCUMENT_TOOLS[0]]) as Array<Record<string, unknown>>
    expect(first.name).toBe('update_document')
    expect(first.input_schema).toEqual(DOCUMENT_TOOLS[0].parameters)
    expect(first.parameters).toBeUndefined()
  })

  it('uppercases types and nests declarations for Gemini', () => {
    // Gemini's schema dialect is OpenAPI-ish with UPPERCASE type names, and it
    // rejects keys it does not know — so the mapping is a rewrite, not a pass.
    const [group] = toGeminiTools([DOCUMENT_TOOLS[1]]) as Array<{ functionDeclarations: Array<{ name: string; parameters: Record<string, unknown> }> }>
    const decl = group.functionDeclarations[0]
    expect(decl.name).toBe('edit_document')
    expect(decl.parameters.type).toBe('OBJECT')
    const edits = (decl.parameters.properties as Record<string, { type: string; items: { type: string } }>).edits
    expect(edits.type).toBe('ARRAY')
    expect(edits.items.type).toBe('OBJECT')
  })
})
