import { describe, it, expect } from 'vitest'
import {
  partialStringArgument,
  applyToolCallDelta,
  finishToolCalls,
  type ToolCallAccumulator
} from '../toolCallStream'

// The live document preview is why the old tag protocol was worth its trouble.
// Tool arguments are JSON, so keeping that preview means reading a string
// value out of a document no JSON parser would accept yet.
describe('partialStringArgument', () => {
  it('reads a value that is still arriving', () => {
    expect(partialStringArgument('{"html": "<p>Hal', 'html')).toBe('<p>Hal')
  })

  it('reads a completed value', () => {
    expect(partialStringArgument('{"html": "<p>Done</p>"}', 'html')).toBe('<p>Done</p>')
  })

  it('returns null before the key arrives', () => {
    expect(partialStringArgument('{"ht', 'html')).toBeNull()
    expect(partialStringArgument('{"note": "hi"}', 'html')).toBeNull()
    expect(partialStringArgument('', 'html')).toBeNull()
  })

  it('returns null when the value has not started', () => {
    // The key is there but the opening quote is not: nothing to show yet.
    expect(partialStringArgument('{"html":', 'html')).toBeNull()
    expect(partialStringArgument('{"html": ', 'html')).toBeNull()
  })

  it('unescapes what has arrived', () => {
    expect(partialStringArgument('{"html": "<p>a\\nb</p>"}', 'html')).toBe('<p>a\nb</p>')
    expect(partialStringArgument('{"html": "say \\"hi\\""}', 'html')).toBe('say "hi"')
  })

  it('stops cleanly on an escape cut in half', () => {
    // The chunk boundary landed inside an escape sequence.
    expect(partialStringArgument('{"html": "<p>a\\', 'html')).toBe('<p>a')
  })

  it('is not confused by a quote inside the value', () => {
    expect(partialStringArgument('{"html": "<a href=\\"x\\">t', 'html')).toBe('<a href="x">t')
  })

  it('skips whitespace variants around the colon', () => {
    expect(partialStringArgument('{"html"   :   "<p>x', 'html')).toBe('<p>x')
  })
})

describe('applyToolCallDelta / finishToolCalls', () => {
  const acc = () => new Map<number, ToolCallAccumulator>()

  it('assembles one call from many deltas', () => {
    const a = acc()
    applyToolCallDelta(a, { index: 0, id: 'call_1', function: { name: 'update_document' } })
    applyToolCallDelta(a, { index: 0, function: { arguments: '{"html":' } })
    applyToolCallDelta(a, { index: 0, function: { arguments: ' "<p>hi</p>"}' } })

    expect(finishToolCalls(a)).toEqual([
      { id: 'call_1', name: 'update_document', args: { html: '<p>hi</p>' } }
    ])
  })

  it('keeps several calls apart and in order', () => {
    const a = acc()
    applyToolCallDelta(a, { index: 1, function: { name: 'second', arguments: '{"b":2}' } })
    applyToolCallDelta(a, { index: 0, function: { name: 'first', arguments: '{"a":1}' } })

    expect(finishToolCalls(a).map(c => c.name)).toEqual(['first', 'second'])
  })

  it('defaults a missing index to 0, as some providers omit it', () => {
    const a = acc()
    applyToolCallDelta(a, { function: { name: 'update_document' } })
    applyToolCallDelta(a, { function: { arguments: '{"html":"x"}' } })

    expect(finishToolCalls(a)).toHaveLength(1)
  })

  it('reports unparseable arguments instead of dropping the call', () => {
    // "The model tried and produced garbage" must be distinguishable from
    // "the model called nothing" — they need different handling.
    const a = acc()
    applyToolCallDelta(a, { index: 0, function: { name: 'update_document', arguments: '{"html": "cut off' } })

    expect(finishToolCalls(a)).toEqual([{ id: undefined, name: 'update_document', args: null }])
  })

  it('ignores an accumulator that never got a name', () => {
    const a = acc()
    applyToolCallDelta(a, { index: 0, function: { arguments: '{"html":"x"}' } })
    expect(finishToolCalls(a)).toEqual([])
  })
})
