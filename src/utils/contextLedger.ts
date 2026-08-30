/**
 * The context ledger: what has already been sent to the model, in the order it
 * was sent. See docs/features/cache_first_context.md.
 *
 * Problem: an ordinary chat turn spent 42.87s before its first token, all of
 *   it prefill, because every attached reference chapter is rebuilt into the
 *   final user message each turn — and because the attachment order is a score
 *   recomputed from the new prompt, an UNCHANGED set of chapters was emitted in
 *   a different order turn over turn. The same engine replays an identical
 *   prefix in 0.2s.
 * Fix: chapters live in an append-only block ahead of the history. Score
 *   decides admission; insertion order decides position, forever. When
 *   something must leave the middle, keep the longest valid prefix and re-send
 *   only the suffix.
 *
 * This module is pure: it plans, it does not render. Rendering lives in
 * hooks/chat/dynamicContext.ts.
 */

/** One chapter as it currently sits in the ledger. */
export interface LedgerEntry {
  id: string
  /** Cheap fingerprint of the exact bytes sent, to detect an edited chapter. */
  hash: string
  /** Chars this entry contributes, for quoting the cost of losing it. */
  chars: number
}

export interface ContextLedger {
  entries: LedgerEntry[]
}

export const EMPTY_LEDGER: ContextLedger = { entries: [] }

/** Why a chapter is leaving the ledger — drives what the user is told. */
export type DropReason =
  /** It became the active document; the volatile tail now holds it. */
  | 'now-active'
  /** Its content changed since it was sent. */
  | 'edited'
  /** The user's selection no longer includes it. */
  | 'user-removed'

export interface LedgerDrop {
  id: string
  reason: DropReason
}

export interface LedgerPlan {
  /** The ledger to send this turn. */
  ledger: ContextLedger
  /** Entries at the head that keep their exact bytes and position. */
  cachedPrefixCount: number
  /** Chars in that cached prefix — what the plan saved. */
  cachedPrefixChars: number
  /** Ids that keep their content but move, so they must be prefilled again. */
  resentIds: string[]
  /** Ids entering the ledger for the first time. */
  appendedIds: string[]
  /** Ids leaving, with the reason each one left. */
  drops: LedgerDrop[]
  /** Chars that must be prefilled again this turn (resent + appended). */
  resendChars: number
  /**
   * True when the user's own selection is what forces cached chapters out, so
   * the send should stop and ask. An active-document switch or an edit is not
   * a choice the user can reconsider, so neither raises this.
   */
  requiresConsent: boolean
}

/** Minimal document shape the planner needs. */
export interface LedgerDocLike {
  id: string
  chars: number
  hash: string
}

/**
 * Fingerprint chapter bytes. FNV-1a over the string: cheap, allocation-free,
 * and collisions only cost a missed invalidation of one chapter — this is not
 * a security boundary.
 */
export function hashContent(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(36)}-${text.length}`
}

/**
 * Plan this turn's ledger.
 *
 * `desiredIds` is what the selector wants attached, in the order it would like
 * NEW entries appended; entries already in the ledger keep their old position
 * regardless of where they appear here.
 *
 * The head of the ledger survives up to the first entry that must leave. That
 * cut point is what makes a chapter switch cheap when the chapter was near the
 * end and expensive when it was near the front.
 */
export function planLedgerTurn(
  current: ContextLedger,
  desiredIds: string[],
  docs: LedgerDocLike[],
  activeDocumentId: string | null
): LedgerPlan {
  const byId = new Map(docs.map(d => [d.id, d]))
  const desired = new Set(desiredIds)

  // Why each existing entry would have to leave, if at all.
  const dropReason = (entry: LedgerEntry): DropReason | null => {
    if (entry.id === activeDocumentId) return 'now-active'
    const doc = byId.get(entry.id)
    // A chapter that vanished from the book is treated as user-removed: the
    // user deleted it, and the bytes cannot be re-sent either way.
    if (!doc) return 'user-removed'
    if (doc.hash !== entry.hash) return 'edited'
    if (!desired.has(entry.id)) return 'user-removed'
    return null
  }

  // 1. The cached prefix runs until the first entry that must go.
  let cut = current.entries.length
  for (let i = 0; i < current.entries.length; i++) {
    if (dropReason(current.entries[i]) !== null) {
      cut = i
      break
    }
  }

  const kept = current.entries.slice(0, cut)
  const cachedPrefixChars = kept.reduce((sum, e) => sum + e.chars, 0)

  // 2. Everything from the cut on: survivors keep their relative order but
  //    move, so they are re-sent; the rest are dropped with their reason.
  const drops: LedgerDrop[] = []
  const resentIds: string[] = []
  const tail: LedgerEntry[] = []
  for (const entry of current.entries.slice(cut)) {
    const reason = dropReason(entry)
    if (reason !== null) {
      drops.push({ id: entry.id, reason })
      continue
    }
    const doc = byId.get(entry.id)!
    tail.push({ id: entry.id, hash: doc.hash, chars: doc.chars })
    resentIds.push(entry.id)
  }

  // 3. New admissions append after everything that survived.
  const present = new Set([...kept, ...tail].map(e => e.id))
  const appendedIds: string[] = []
  for (const id of desiredIds) {
    if (present.has(id) || id === activeDocumentId) continue
    const doc = byId.get(id)
    if (!doc) continue
    tail.push({ id, hash: doc.hash, chars: doc.chars })
    appendedIds.push(id)
    present.add(id)
  }

  const resendChars = tail.reduce((sum, e) => sum + e.chars, 0)

  return {
    ledger: { entries: [...kept, ...tail] },
    cachedPrefixCount: kept.length,
    cachedPrefixChars,
    resentIds,
    appendedIds,
    drops,
    resendChars,
    requiresConsent: drops.some(d => d.reason === 'user-removed')
  }
}

/**
 * The same plan with the user-removed chapters kept instead — what the
 * "保留该章并继续 / keep it and continue" button sends. The chapter stays in
 * the ledger (costing budget but no prefill) while no longer being presented
 * as selected.
 */
export function planKeepingRemoved(
  current: ContextLedger,
  desiredIds: string[],
  docs: LedgerDocLike[],
  activeDocumentId: string | null
): LedgerPlan {
  const stillWanted = current.entries
    .filter(e => e.id !== activeDocumentId)
    .map(e => e.id)
  const union = [...stillWanted]
  for (const id of desiredIds) {
    if (!union.includes(id)) union.push(id)
  }
  return planLedgerTurn(current, union, docs, activeDocumentId)
}

/**
 * Order new admissions so that the ones most likely to become the active
 * document next are appended LAST. Switching to a chapter truncates the ledger
 * at its position, so the further back it sits, the less has to be re-sent.
 * Adjacency in book order is the predictor: the writer moves to the next or
 * previous chapter far more often than to a distant one.
 */
export function orderAdmissionsForSwitchCost(
  ids: string[],
  bookOrder: string[],
  activeDocumentId: string | null
): string[] {
  const activeIdx = bookOrder.indexOf(activeDocumentId ?? '')
  if (activeIdx === -1) return [...ids]
  const distance = (id: string) => {
    const idx = bookOrder.indexOf(id)
    return idx === -1 ? Number.MAX_SAFE_INTEGER : Math.abs(idx - activeIdx)
  }
  // Farthest first, nearest last: nearest is the likeliest next switch.
  return [...ids].sort((a, b) => distance(b) - distance(a))
}
