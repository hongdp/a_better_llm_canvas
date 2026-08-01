/**
 * Pure pieces of the chat streaming pipeline: the incremental tag splitter
 * run on every chunk, and the no-action-retry constants + completion-warning
 * builder used by onDone. Nothing here touches the editor, hook refs, or the
 * store — the ref-coupled parts (live previews, editor transactions, the
 * retry re-dispatch) stay in useChatLLM.
 */

// Recovery rounds per turn when the model answers a write request without any
// action tag (nothing reaches the document). Measured against grok-4.5 on a
// real chapter-rewrite request (n=8, 2026-07-25): 0 retries → 2/8 turns
// produced content, 1 → 4/8, 2 → 7/8, 3 → 8/8. Failures are independent
// re-rolls, not a stuck state, and a failed round costs ~25 output tokens, so
// three is the point where the curve flattens.
export const MAX_NO_ACTION_RETRIES = 3
export const NO_ACTION_RETRY_INSTRUCTION = `Your previous reply contained no <canvas>, <edit> or <selection_replace> tag, so NOTHING was written to the document — the user saw only your message.

Redo this turn:
- If the request needs a document change, emit it now inside the tags, with the full content (no summaries, no "as above").
- If it genuinely needs no document change, answer normally and say what you need from the user.`

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

  return { chatText, canvasText, selectionReplaceText, isSelectionEdit }
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
  reinsertedImages: number
}): string {
  const { canvasIssue, editFailedCount, exhaustedNoActionRetries, reinsertedImages } = params

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
    warningNote += `\n\n⚠️ The model answered without producing any document content (retried ${MAX_NO_ACTION_RETRIES} times), so your document is unchanged. Ask again — naming the chapter or section usually helps.`
  }
  if (reinsertedImages > 0) {
    warningNote += `\n\nℹ️ ${reinsertedImages} image${reinsertedImages > 1 ? 's' : ''} missing from the rewrite ${reinsertedImages > 1 ? 'were' : 'was'} restored near ${reinsertedImages > 1 ? 'their' : 'its'} original position. Delete ${reinsertedImages > 1 ? 'them' : 'it'} manually if the removal was intended.`
  }
  return warningNote
}
