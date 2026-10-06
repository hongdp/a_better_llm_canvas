/**
 * One step's output → the tool invocations it asked for.
 *
 * Two sources feed the same list (spec D1):
 *  - native tool calls, and
 *  - the markup protocol's `<canvas>` / `<edit>` / `<selection_replace>`
 *    blocks, parsed into the SAME update_document / edit_document /
 *    replace_selection invocations a native call would have produced.
 *
 * So the rest of the loop never asks which protocol a write came from.
 */
import type { FinishedToolCall } from '../utils/toolCallStream'
import { parseAssistantResponse, stripStrayDocumentMarkup, type ParsedAssistantResponse } from '../utils/text'
import type { ToolRegistry } from './registry'
import type { ToolInvocation } from './types'

export interface CollectedStep {
  /** In the order the model gave them: native calls first, then markup. */
  invocations: ToolInvocation[]
  /** The reply with every document block removed — what the bubble shows. */
  chatText: string
  /** Document markup no channel took (never shown raw; counted instead). */
  strayMarkup: number
  /** Native calls naming a tool this registry does not have. */
  unknownCalls: number
  /** The markup parse's verdict; null when native writes made it moot. */
  markupKind: ParsedAssistantResponse['kind'] | null
}

function markupInvocations(parsed: ParsedAssistantResponse, step: number): ToolInvocation[] {
  const id = (i: number) => `markup_${step}_${i}`
  switch (parsed.kind) {
    case 'selection': {
      const out: ToolInvocation[] = [
        { id: id(0), name: 'replace_selection', args: { html: parsed.selectionText }, source: 'markup' }
      ]
      // Edits written beside a selection rewrite (they target text outside it).
      if (parsed.editBlocks.length > 0) {
        out.push({ id: id(1), name: 'edit_document', args: { edits: parsed.editBlocks }, source: 'markup' })
      }
      return out
    }
    case 'edits':
      return [{ id: id(0), name: 'edit_document', args: { edits: parsed.editBlocks }, source: 'markup' }]
    case 'canvas':
      return [{
        id: id(0),
        name: 'update_document',
        args: { html: parsed.canvasText },
        source: 'markup',
        unclosed: !parsed.canvasClosed
      }]
    default:
      return []
  }
}

export function collectStep(
  text: string,
  nativeCalls: FinishedToolCall[],
  registry: ToolRegistry,
  step: number
): CollectedStep {
  // Every native call is kept, known or not: each id must be answered if the
  // run continues, and the run answers an unknown name with an error result.
  const native: ToolInvocation[] = nativeCalls.map((c, i) => ({
    id: c.id || `call_${step}_${i}`,
    name: c.name,
    args: c.args,
    source: 'native',
    argumentsText: c.argumentsText
  }))
  const unknownCalls = nativeCalls.filter(c => !registry.get(c.name)).length

  // A native WRITE means the model is on the tool protocol for writes, so any
  // tag markup beside it took no channel: it is stray, never applied and never
  // shown. Without one (no calls, or only reads — the hybrid case, where
  // writes are tags by design) the markup is parsed and applied.
  if (native.some(inv => registry.get(inv.name)?.kind === 'write')) {
    const stray = stripStrayDocumentMarkup(text)
    return { invocations: native, chatText: stray.text, strayMarkup: stray.removed, unknownCalls, markupKind: null }
  }

  const parsed = parseAssistantResponse(text)
  return {
    invocations: [...native, ...markupInvocations(parsed, step)],
    chatText: parsed.chatText,
    strayMarkup: parsed.strayMarkup,
    unknownCalls,
    markupKind: parsed.kind
  }
}

/**
 * Which of a step's writes run, in what order, and how many are dropped.
 *
 * A selection rewrite leads: it is placed first and edits beside it apply
 * around it. A full rewrite cannot coexist with it — it would overwrite the
 * selection's pending diff — so it is dropped and counted (the markup
 * protocol's priority, and what the completion note reports as stray).
 *
 * Without a selection every write runs in the model's order; they compose on
 * the run's working copy. (Before the loop only the FIRST native write ran
 * and any further one was dropped.)
 */
export function planWrites(
  writes: ToolInvocation[]
): { run: ToolInvocation[]; dropped: number } {
  const selection = writes.find(w => w.name === 'replace_selection')
  if (!selection) return { run: writes, dropped: 0 }
  const run = [selection, ...writes.filter(w => w.name === 'edit_document')]
  return { run, dropped: writes.length - run.length }
}
