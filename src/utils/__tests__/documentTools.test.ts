import { describe, it, expect } from 'vitest'
import {
  DOCUMENT_TOOLS,
  toolsForTurn,
  toOpenAITools,
  toAnthropicTools,
  toGeminiTools,
  toolCallToParsedResponse
} from '../documentTools'

// The tag protocol asked every model to learn a private language. A local
// Qwen3-14B never emitted <canvas> under it, and produced a correct tool call
// on the first attempt with these — the format is in its training data.
describe('toolsForTurn', () => {
  it('offers replace_selection only when there is a selection', () => {
    const withSel = toolsForTurn({ hasSelection: true }).map(t => t.name)
    const without = toolsForTurn({ hasSelection: false }).map(t => t.name)
    expect(withSel).toContain('replace_selection')
    expect(without).not.toContain('replace_selection')
  })

  it('always offers the two that always apply', () => {
    const names = toolsForTurn({ hasSelection: false }).map(t => t.name)
    expect(names).toEqual(['update_document', 'edit_document'])
  })
})

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

describe('toolCallToParsedResponse', () => {
  it('maps update_document onto the canvas path', () => {
    const r = toolCallToParsedResponse({ name: 'update_document', args: { html: '<p>new</p>' } }, 'Done.')
    expect(r).toMatchObject({ kind: 'canvas', canvasText: '<p>new</p>', canvasClosed: true, chatText: 'Done.' })
  })

  it('maps replace_selection onto the selection path', () => {
    const r = toolCallToParsedResponse({ name: 'replace_selection', args: { html: '<p>rewritten</p>' } }, '')
    expect(r).toMatchObject({ kind: 'selection', selectionText: '<p>rewritten</p>' })
  })

  it('maps edit_document onto edit blocks', () => {
    const r = toolCallToParsedResponse(
      { name: 'edit_document', args: { edits: [{ search: '<p>a</p>', replace: '<p>b</p>' }] } },
      ''
    )
    expect(r.kind).toBe('edits')
    expect(r.editBlocks).toEqual([{ search: '<p>a</p>', replace: '<p>b</p>' }])
  })

  it('treats a missing replace as a deletion, not a crash', () => {
    const r = toolCallToParsedResponse({ name: 'edit_document', args: { edits: [{ search: '<p>gone</p>' }] } }, '')
    expect(r.editBlocks).toEqual([{ search: '<p>gone</p>', replace: '' }])
  })

  it('drops malformed edit entries rather than applying them', () => {
    const r = toolCallToParsedResponse(
      { name: 'edit_document', args: { edits: [{ replace: 'no search' }, null, { search: '<p>ok</p>', replace: '' }] } },
      ''
    )
    expect(r.editBlocks).toHaveLength(1)
  })

  it('reports cut-off arguments as an unclosed canvas', () => {
    // Unparseable JSON means the model was truncated mid-call. Routing it to
    // the existing "truncated, nothing applied" path is safer than writing
    // half a document.
    const r = toolCallToParsedResponse({ name: 'update_document', args: null }, 'partial')
    expect(r).toMatchObject({ kind: 'canvas', canvasClosed: false, canvasText: '' })
  })

  it('leaves an unknown tool as plain chat', () => {
    expect(toolCallToParsedResponse({ name: 'something_else', args: {} }, 'hi').kind).toBe('chat')
  })
})
