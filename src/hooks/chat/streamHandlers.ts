/**
 * Pure pieces of the chat streaming pipeline: the incremental tag splitter
 * run on every chunk, and the no-action-retry constants + completion-warning
 * builder used by onDone. Nothing here touches the editor, hook refs, or the
 * store — the ref-coupled parts (live previews, editor transactions, the
 * retry re-dispatch) stay in useChatLLM.
 */
import { stripDocStatus } from '../../utils/text'

// Recovery rounds per turn when the model answers a write request without any
// action tag (nothing reaches the document). Measured against grok-4.5 on a
// real chapter-rewrite request (n=8, 2026-07-25): 0 retries → 2/8 turns
// produced content, 1 → 4/8, 2 → 7/8, 3 → 8/8. Failures are independent
// re-rolls, not a stuck state, and a failed round costs ~25 output tokens, so
// three is the point where the curve flattens.
/**
 * Bubble text between "the turn started" and the first token. Shared so the
 * chat panel can recognise the wait and show it as such, rather than showing a
 * spinner that looks identical to a stalled connection.
 */
export const ASSISTANT_PLACEHOLDER = 'Thinking...'

/** How much of the model's thinking to keep on screen. */
export const REASONING_TAIL_CHARS = 240
/** Minimum gap between reasoning repaints — deltas arrive far faster. */
export const REASONING_PAINT_MS = 250

export const MAX_NO_ACTION_RETRIES = 3
export const NO_ACTION_RETRY_INSTRUCTION = `Your previous reply did not follow the output protocol, so NOTHING reached the document — the user saw only your message.

Redo this turn. Exactly one of these two shapes is acceptable:
- You are changing the document: emit the change inside <canvas>, <edit> or <selection_replace>, with the full content (no summaries, no "as above"), and end with <doc_status>updated</doc_status>.
- You are NOT changing the document: answer normally, say what you need from the user, and end with <doc_status>unchanged</doc_status>. This is a perfectly good answer — but you may not say or imply that you edited anything.

The <doc_status> line is required either way, and it must match what you actually emitted.`

/** How a partially-streamed response splits into chat text vs. document markup. */
export interface StreamingSplit {
  /** Conversational text destined for the chat bubble. */
  chatText: string
  /** Body of a (possibly still-open) <canvas> block; empty when absent. */
  canvasText: string
  /** Body of a (possibly still-open) <selection_replace> block; empty when absent. */
  selectionReplaceText: string
  isSelectionEdit: boolean
}

/**
 * Locate a passage by its TEXT in a live ProseMirror document.
 *
 * Used when a reload destroyed the selection range: `<edit>` blocks have
 * always relocated themselves by content, and a selection rewrite can do the
 * same instead of being dropped.
 *
 * It walks the real node tree rather than doing string arithmetic on HTML. A
 * plain-text index is NOT a ProseMirror position — every block boundary adds
 * one — so an offset computed from a string lands further off with each
 * preceding paragraph, which is worse than not relocating at all.
 *
 * Returns null when the passage is missing or ambiguous: rewriting the wrong
 * paragraph is a worse outcome than reporting the selection gone.
 */
export interface TextNodeSpan {
  text: string
  from: number
}

export function findTextRangeInSpans(spans: TextNodeSpan[], selectedText: string): { from: number; to: number } | null {
  const needle = (selectedText || '').trim()
  if (!needle) return null

  // One flat string, with a map back to document positions per character.
  let flat = ''
  const positions: number[] = []
  for (const span of spans) {
    for (let i = 0; i < span.text.length; i++) {
      flat += span.text[i]
      positions.push(span.from + i)
    }
  }

  const first = flat.indexOf(needle)
  if (first === -1) return null
  if (flat.indexOf(needle, first + 1) !== -1) return null   // ambiguous

  const from = positions[first]
  const lastChar = positions[first + needle.length - 1]
  return { from, to: lastChar + 1 }
}

/** Collect the text nodes of a ProseMirror doc with their positions. */
export function collectTextSpans(doc: {
  descendants: (fn: (node: { isText?: boolean; text?: string }, pos: number) => void) => void
}): TextNodeSpan[] {
  const spans: TextNodeSpan[] = []
  doc.descendants((node, pos) => {
    if (node.isText && node.text) spans.push({ text: node.text, from: pos })
  })
  return spans
}

/**
 * Recover the range of a selection whose page died mid-turn.
 *
 * A resumed job carries the selected TEXT, not positions — ProseMirror
 * positions do not survive the editor that produced them. Relocating it
 * against the live document is what lets a rejoined selection rewrite preview
 * and settle where the user actually selected. No-ops once relocated, and
 * whenever there was no resumed selection to begin with.
 *
 * Module-level, taking the refs as arguments, deliberately: a useCallback here
 * would capture them and destabilise the streaming callbacks, whose identity
 * has to stay fixed (see the timeout note in CLAUDE.md — an unstable callback
 * in effect deps is how the test runner wedges). It is shared by all three
 * callers — tool-call preview, markup preview, and the final apply — because
 * the markup one was MISSING it, so after a refresh `selectionRange` stayed
 * null and the live preview was skipped for the whole turn.
 */
export function relocateResumedSelection(
  editor: { state: { doc: Parameters<typeof collectTextSpans>[0] } },
  refs: {
    pendingSelectionText: { current: string | null }
    selectionRange: { current: { from: number; to: number } | null }
    selectionEnd: { current: number | null }
  }
): void {
  const pending = refs.pendingSelectionText.current
  if (!pending) return
  const relocated = findTextRangeInSpans(collectTextSpans(editor.state.doc), pending)
  refs.pendingSelectionText.current = null
  refs.selectionRange.current = relocated
  refs.selectionEnd.current = relocated?.to ?? null
}

export function clampSelectionRange(
  from: number,
  to: number,
  docSize: number
): { from: number; to: number } | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || docSize < 0) return null
  if (from < 0 || from > docSize) return null
  return { from, to: Math.min(Math.max(to, from), docSize) }
}

/**
 * Split the accumulated raw stream into conversational text and document
 * markup. Called on every chunk with the FULL text so far — it must tolerate
 * tags that have opened but not yet closed.
 */
export function splitStreamingResponse(raw: string): StreamingSplit {
  let chatText: string
  let canvasText = ''
  let selectionReplaceText = ''
  let isSelectionEdit = false

  const canvasStart = '<canvas>'
  const canvasEnd = '</canvas>'
  const selectionStart = '<selection_replace>'
  const selectionEndTag = '</selection_replace>'

  const canvasIdx = raw.indexOf(canvasStart)
  const selectionIdx = raw.indexOf(selectionStart)
  // First sign of an <edit> block (open tag or a SEARCH conflict marker).
  const editMatchIdx = raw.search(/<edit\b|<{5,}\s*SEARCH/i)

  if (selectionIdx !== -1) {
    isSelectionEdit = true
    chatText = raw.substring(0, selectionIdx).trim()
    const rest = raw.substring(selectionIdx + selectionStart.length)
    const endIdx = rest.indexOf(selectionEndTag)
    if (endIdx !== -1) {
      selectionReplaceText = rest.substring(0, endIdx)
      chatText += '\n\n' + rest.substring(endIdx + selectionEndTag.length).trim()
    } else {
      selectionReplaceText = rest
    }
  } else if (editMatchIdx !== -1 && (canvasIdx === -1 || editMatchIdx < canvasIdx)) {
    // Edit blocks are applied on completion; during streaming just hide
    // the noisy SEARCH/REPLACE markup and show the surrounding chat.
    chatText = raw.substring(0, editMatchIdx).trim()
  } else if (canvasIdx !== -1) {
    chatText = raw.substring(0, canvasIdx).trim()
    const rest = raw.substring(canvasIdx + canvasStart.length)
    const endIdx = rest.indexOf(canvasEnd)
    if (endIdx !== -1) {
      canvasText = rest.substring(0, endIdx)
      chatText += '\n\n' + rest.substring(endIdx + canvasEnd.length).trim()
    } else {
      canvasText = rest
    }
  } else {
    chatText = raw
  }

  return { chatText: stripDocStatus(chatText), canvasText, selectionReplaceText, isSelectionEdit }
}

/**
 * Assemble the user-facing warning suffix appended to the assistant bubble
 * after a completed stream. Order is deliberate: destructive-replacement
 * guards first, then skipped edits, then the exhausted no-action retries,
 * then the informational image-restore note.
 */
export function buildCompletionWarnings(params: {
  canvasIssue: 'truncated' | 'elided' | null
  editFailedCount: number
  /** All no-action retries used and the last reply still had no tags. */
  exhaustedNoActionRetries: boolean
  /** A finished selection edit had nowhere valid left to land. */
  selectionGone?: boolean
  /** The reply produced no usable document update and cannot be retried. */
  unretriableFailedUpdate?: boolean
  /** A document tool was called but its arguments yielded nothing to apply. */
  toolCallProducedNothing?: boolean
  reinsertedImages: number
}): string {
  const { canvasIssue, editFailedCount, exhaustedNoActionRetries, selectionGone, unretriableFailedUpdate, toolCallProducedNothing, reinsertedImages } = params

  let warningNote = canvasIssue === 'truncated'
    ? '\n\n⚠️ The response was cut off before the document update finished, so no changes were applied (your document is unchanged). Please retry — for long documents, try editing a smaller selection at a time.'
    : canvasIssue === 'elided'
    ? '\n\n⚠️ The response abbreviated unchanged parts of the document, so applying it would have deleted content. No changes were applied. Please retry — for long documents, try editing a smaller selection at a time.'
    : ''
  if (editFailedCount > 0) {
    warningNote += `\n\n⚠️ ${editFailedCount} suggested change${editFailedCount > 1 ? 's' : ''} could not be located in the current document and ${editFailedCount > 1 ? 'were' : 'was'} skipped. The text to change may have moved or differ from what was matched.`
  }
  // The recovery round also came back without tags: say so instead
  // of letting "已改好" stand over an unchanged document.
  if (exhaustedNoActionRetries) {
    warningNote += `\n\n⚠️ The model never produced a valid document update or a clear "no change" declaration (retried ${MAX_NO_ACTION_RETRIES} times), so your document is unchanged. Ask again — naming the chapter or section usually helps.`
  }
  if (toolCallProducedNothing) {
    warningNote += '\n\n⚠️ The model started a document change but its request could not be used (empty or malformed arguments), so your document is unchanged. Try again — a shorter, more specific instruction usually helps.'
  }
  if (unretriableFailedUpdate) {
    warningNote += '\n\n⚠️ This reply produced no usable document update, and it was resumed after a reload — so there is no request left to retry with. Your document is unchanged; send the instruction again to have another go.'
  }
  if (selectionGone) {
    warningNote += '\n\n⚠️ The text you had selected is no longer where it was (the chapter changed while this ran), so nothing was written. The rewrite is above — paste it where you want it, or select the text again and retry.'
  }
  if (reinsertedImages > 0) {
    warningNote += `\n\nℹ️ ${reinsertedImages} image${reinsertedImages > 1 ? 's' : ''} missing from the rewrite ${reinsertedImages > 1 ? 'were' : 'was'} restored near ${reinsertedImages > 1 ? 'their' : 'its'} original position. Delete ${reinsertedImages > 1 ? 'them' : 'it'} manually if the removal was intended.`
  }
  return warningNote
}
