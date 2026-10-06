/**
 * Freshness markers (agentic_chat_loop.md D8): the model learns, line by line
 * in the CHAPTER INDEX, which chapters it has in full, and which ones changed
 * since it last saw them.
 *
 * Keyed on a hash of the ACCEPTED reading (pending diff markup stripped):
 * accepting the agent's own diff is no change for the model; rejecting it is
 * — and the model needs to learn its edit was rejected. Timestamps cannot
 * tell those two apart, and `updatedAt` moves when no text changed.
 *
 * Pure. The hook owns the record (session-scoped, like the ledger).
 */
import { stripDiffMarkup } from '../utils/diff'
import { hashContent } from '../utils/contextLedger'

/** Chapter id → what the model was last shown of it. */
export type SeenRecord = Map<string, { hash: string; turn: number }>

export const IN_CONTEXT = 'in context'
/**
 * In context, and different from what the model saw last time. The ledger
 * re-sends an edited chapter in full, so the model HAS the new text — but
 * nothing told it so, while its own earlier replies in the history were
 * planned against the old one (user-reported: an outline revised before
 * "write chapter 6" went unnoticed). Codex states the same for its context
 * updates: the new copy replaces the one provided before.
 */
export const IN_CONTEXT_CHANGED = 'in context — CHANGED since you last saw it; the text here replaces the earlier one'
export const CHANGED = 'changed since you read it'
export const NOT_IN_CONTEXT = 'read earlier, not in context'

export function acceptedHash(html: string): string {
  return hashContent(stripDiffMarkup(html))
}

/** The model has just been shown `html` as chapter `id`. */
export function recordSeen(seen: SeenRecord, id: string, html: string, turn: number): void {
  seen.set(id, { hash: acceptedHash(html), turn })
}

export interface MarkableDoc {
  id: string
  content: string
  /** False while a server book's chapter is still metadata-only. */
  contentLoaded?: boolean
}

/**
 * Markers for this turn's index, and the record updated with what this
 * request shows. The active chapter gets none: its index line already says
 * ACTIVE, and its text is in the request.
 */
export function freshnessMarkers(
  documents: MarkableDoc[],
  activeDocumentId: string | null,
  inContextIds: Iterable<string>,
  seen: SeenRecord,
  turn: number
): Record<string, string> {
  const inContext = new Set(inContextIds)
  const markers: Record<string, string> = {}
  for (const doc of documents) {
    if (doc.id === activeDocumentId) continue
    const prev = seen.get(doc.id)
    if (inContext.has(doc.id)) {
      const changed = prev !== undefined && !(doc.contentLoaded === false && !doc.content) &&
        prev.hash !== acceptedHash(doc.content)
      markers[doc.id] = changed ? IN_CONTEXT_CHANGED : IN_CONTEXT
      continue
    }
    if (!prev) continue
    // Not loaded: nothing to hash. The model saw it once; whether it changed
    // since is unknown, and "not in context" is the honest half of that.
    if (doc.contentLoaded === false && !doc.content) {
      markers[doc.id] = NOT_IN_CONTEXT
      continue
    }
    markers[doc.id] = prev.hash === acceptedHash(doc.content) ? NOT_IN_CONTEXT : CHANGED
  }
  // What this request carries is now what the model has seen.
  for (const doc of documents) {
    if (doc.id === activeDocumentId || inContext.has(doc.id)) recordSeen(seen, doc.id, doc.content, turn)
  }
  return markers
}
