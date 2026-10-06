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
import { parseAssistantResponse, stripStrayDocumentMarkup, type EditBlock, type ParsedAssistantResponse } from '../utils/text'
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

/**
 * Edit blocks, one edit_document call per chapter they name (`<edit
 * chapter="…">`), in the order each chapter first appears.
 */
function editsByChapter(blocks: EditBlock[]): Record<string, unknown>[] {
  const groups = new Map<string, EditBlock[]>()
  for (const block of blocks) {
    const key = block.chapter ?? ''
    const { chapter: _chapter, ...edit } = block
    void _chapter
    groups.set(key, [...(groups.get(key) ?? []), edit])
  }
  return [...groups.entries()].map(([chapter, edits]) => (chapter ? { chapter, edits } : { edits }))
}

function markupInvocations(parsed: ParsedAssistantResponse, step: number): ToolInvocation[] {
  let n = 0
  const make = (name: string, args: Record<string, unknown>, unclosed?: boolean): ToolInvocation => ({
    id: `markup_${step}_${n++}`,
    name,
    args,
    source: 'markup',
    ...(unclosed === undefined ? {} : { unclosed })
  })
  const out: ToolInvocation[] = []
  if (parsed.kind === 'selection') {
    out.push(make('replace_selection', { html: parsed.selectionText }))
  }
  if (parsed.kind === 'canvas') {
    out.push(make('update_document', {
      html: parsed.canvasText,
      ...(parsed.canvasChapter ? { chapter: parsed.canvasChapter } : {})
    }, !parsed.canvasClosed))
  }
  // Edits: the 'edits' channel, or written beside a selection rewrite (they
  // target text outside it).
  if (parsed.kind === 'selection' || parsed.kind === 'edits') {
    for (const args of editsByChapter(parsed.editBlocks)) out.push(make('edit_document', args))
  }
  // Rewrites of other chapters that rode along (`<canvas chapter="…">`).
  for (const extra of parsed.extraCanvases) {
    out.push(make('update_document', { html: extra.text, chapter: extra.chapter }, !extra.closed))
  }
  return out
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
    argumentsText: c.argumentsText,
    ...(c.signature ? { signature: c.signature } : {})
  }))
  const unknownCalls = nativeCalls.filter(c => !registry.get(c.name)).length

  // A native call of a write that HAS a tag form means the model is on the
  // tool protocol for writes, so any tag markup beside it took no channel: it
  // is stray, never applied and never shown. Without one (no calls, reads, or
  // writes that only exist as calls — polish_chapter, delete_chapter — the
  // hybrid case, where document text is tags by design) the markup is parsed
  // and applied.
  if (native.some(inv => {
    const tool = registry.get(inv.name)
    return tool?.kind === 'write' && !!tool.markupForm
  })) {
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
  // A rewrite that names a chapter targets another chapter (the tool refuses
  // it if that chapter is the selection's); only an unnamed one collides.
  const run = [selection, ...writes.filter(w =>
    w.name === 'edit_document' || (w.name === 'update_document' && w.args?.chapter !== undefined))]
  return { run, dropped: writes.length - run.length }
}
