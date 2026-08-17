/**
 * Reading a tool call while it is still arriving.
 *
 * The live document preview is the feature that made the old tag protocol
 * worth its trouble: text streamed straight into the editor. Tool arguments
 * are JSON, so the naive reading is "wait for valid JSON, then apply" — which
 * would replace a live preview with a wait.
 *
 * It is not necessary. Arguments arrive as string deltas (measured on a local
 * llama.cpp: 54 deltas, first at 0.3s), so the partially-written value of a
 * known key can be recovered from an incomplete document — `{"html": "<p>Hal`
 * yields `<p>Hal`. That is exactly what the preview needs.
 */

export interface ToolCallAccumulator {
  /** Provider-assigned id, when there is one. */
  id?: string
  name?: string
  /** Raw JSON text so far — not necessarily parseable. */
  argumentsText: string
}

/**
 * Extract the value of a top-level string key from JSON that may be cut off
 * mid-value. Returns null when the key has not started arriving yet.
 *
 * Deliberately not a JSON parser: it must succeed on input no parser accepts.
 */
export function partialStringArgument(argumentsText: string, key: string): string | null {
  const text = argumentsText || ''
  const keyMarker = `"${key}"`
  const keyAt = text.indexOf(keyMarker)
  if (keyAt === -1) return null

  // Step past `"key"` , optional whitespace, `:` , optional whitespace.
  let i = keyAt + keyMarker.length
  while (i < text.length && /\s/.test(text[i])) i++
  if (text[i] !== ':') return null
  i++
  while (i < text.length && /\s/.test(text[i])) i++
  if (text[i] !== '"') return null
  i++

  let out = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined) break        // escape cut in half: stop cleanly
      out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next
      i += 2
      continue
    }
    if (ch === '"') break                  // value complete
    out += ch
    i++
  }
  return out
}

/**
 * Merge one OpenAI-style streaming tool_call delta into the accumulator.
 *
 * `replace` marks a REPLAY: after a reload the server sends each call's
 * arguments whole rather than in fragments, because there is no offset to
 * resume a tool call from. Appending that to whatever a reader already has
 * would duplicate the argument text and produce invalid JSON.
 */
export function applyToolCallDelta(
  accumulators: Map<number, ToolCallAccumulator>,
  delta: {
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
    replace?: boolean
  }
): void {
  const index = typeof delta.index === 'number' ? delta.index : 0
  const existing = accumulators.get(index) ?? { argumentsText: '' }
  if (delta.id) existing.id = delta.id
  if (delta.function?.name) existing.name = delta.function.name
  if (delta.function?.arguments !== undefined) {
    existing.argumentsText = delta.replace
      ? delta.function.arguments
      : existing.argumentsText + delta.function.arguments
  }
  accumulators.set(index, existing)
}

export interface FinishedToolCall {
  id?: string
  name: string
  /** Parsed arguments, or null when the model produced unparseable JSON. */
  args: Record<string, unknown> | null
}

/**
 * Finalize the accumulators. A call whose JSON never became valid is reported
 * with `args: null` rather than dropped: the caller must be able to tell "the
 * model tried and produced garbage" from "the model did not call anything".
 */
export function finishToolCalls(accumulators: Map<number, ToolCallAccumulator>): FinishedToolCall[] {
  return [...accumulators.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => acc)
    .filter((acc): acc is ToolCallAccumulator & { name: string } => !!acc.name)
    .map(acc => {
      let args: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(acc.argumentsText || '{}')
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
      } catch {
        args = null
      }
      return { id: acc.id, name: acc.name, args }
    })
}
