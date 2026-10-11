/**
 * Prompt assembly for a chat request, split by volatility.
 *
 * The layout (docs/features/cache_first_context.md):
 *
 *   [ system ]                    stable for the session
 *   [ ledger block ]              append-only, ahead of the history
 *   [ history ]                   append-only
 *   [ volatile tail ]             re-prefilled every turn, deliberately
 *
 * Reference chapters live in the ledger block, so a turn that changes nothing
 * re-prefills only the active document and the request. They used to sit in
 * the final user message, where an unchanged set of chapters was rebuilt —
 * and reordered, since their order came from a score recomputed per prompt —
 * on every single turn.
 */
import { stripDiffMarkup } from '../../utils/diff'
import { pendingChanges, renderPendingChanges } from '../../utils/pendingChanges'
import { truncateWithNotice, htmlToPlainText } from '../../utils/llmContext'
import { hashContent } from '../../utils/contextLedger'
import { buildChapterIndex } from '../../utils/chapterIndex'
import type { LLMMessage } from '../../types/llm'

// Per-document cap for read-only reference documents attached as context.
const MAX_REFERENCE_DOC_CHARS = 20_000

/**
 * What rendering needs from a document. Passed in rather than read from the
 * store: these functions decide what the model sees, so they must be callable
 * — and assertable — outside a running app. The acceptance harness in
 * scripts/acceptance builds real prompts with them.
 */
export interface RenderableDoc {
  id: string
  title: string
  content: string
}

export interface DynamicContextOptions {
  /** The agentic loop's tools are on: the model may write any chapter. */
  agentTools?: boolean
  /** Freshness markers for the chapter index (agentic_chat_loop.md D8). */
  markers?: Record<string, string>
  /**
   * The active chapter is pinned and its copy in the ledger is older than its
   * text now (pinned_context.md §2.1): say which one is current.
   */
  activeCopyOlder?: boolean
  /**
   * Parts decided by diffTailParts (cache_continuity.md §3.2): the chapter
   * index block and the active chapter's block as they go out this turn,
   * full or abbreviated; and pinned-chapter updates (§3.3) after the index.
   */
  indexOverride?: string
  activeOverride?: string
  pinnedBlock?: string
}

/** One chapter as it is rendered into the ledger block. */
export function renderLedgerChapter(title: string, content: string, perDocChars: number): string {
  return `--- DOCUMENT: ${title} ---\n${truncateWithNotice(htmlToPlainText(content), perDocChars)}\n`
}

/**
 * A chapter's block in the ledger, from its ACCEPTED reading.
 *
 * Problem: chapters were rendered from their raw HTML. A chapter with an
 *   unresolved review diff became plain text with the deleted and the
 *   inserted words run together ("oldnew"), and accepting that diff changed
 *   the bytes — so the chapter counted as edited and was re-sent.
 * Fix: render (and hash, see useChatLLM) the text as it reads with every
 *   pending change accepted — what read_chapter and the active document
 *   already show the model.
 *
 * `update` marks a newer version appended after an older copy that stays in
 * place for the prompt cache (contextLedger append-updates).
 */
export function ledgerBlock(doc: RenderableDoc, kind: 'fresh' | 'update' = 'fresh', perDocChars: number = MAX_REFERENCE_DOC_CHARS): string {
  const title = kind === 'update'
    ? `${doc.title} (UPDATED — this version replaces the earlier copy of this chapter above; disregard that one)`
    : doc.title
  return renderLedgerChapter(title, stripDiffMarkup(doc.content), perDocChars)
}

/**
 * The stable, append-only block of reference chapters, injected ahead of the
 * chat history as a user/assistant pair: providers cache a prefix, not a set
 * of fields.
 *
 * Returns [] for an empty ledger so the caller can spread it unconditionally.
 */
export function buildLedgerMessages(
  documents: RenderableDoc[],
  /**
   * The ledger, in order: chapter ids, or entries carrying the exact block
   * they were sent with (`text`) — an entry's bytes must not change between
   * turns, even after its chapter did.
   */
  ledger: Array<string | { id: string; text?: string }>,
  perDocChars: number = MAX_REFERENCE_DOC_CHARS,
  opts: { agentTools?: boolean } = {}
): LLMMessage[] {
  if (ledger.length === 0) return []

  const chapters = ledger
    .map(item => {
      const entry = typeof item === 'string' ? { id: item } : item
      if (entry.text) return entry.text
      const doc = documents.find(d => d.id === entry.id)
      return doc ? ledgerBlock(doc, 'fresh', perDocChars) : ''
    })
    .filter(Boolean)
    .join('\n')

  if (!chapters) return []

  // With the agent tools the model may change any chapter (agentic loop D2);
  // telling it these are "never edit" would contradict its own tools.
  const header = opts.agentTools
    ? 'REFERENCED CHAPTERS (full text, as plain text, for details and consistency; to change one, read its HTML with read and name it in your write):'
    : 'REFERENCED CHAPTERS (read-only; use them for details and consistency, never edit them):'
  return [
    {
      role: 'user',
      content: `${header}\n\n${chapters}`,
      cacheHint: true
    },
    // Providers require alternating roles; the ack keeps history's leading
    // user turn valid after the injected user message.
    { role: 'assistant', content: 'Understood. I have read these chapters and will use them as reference.' }
  ]
}

/**
 * The volatile tail: whatever must reflect this exact turn. Merged into the
 * final user message, after the history.
 *
 * The chapter index lives here rather than in the ledger by decision: it moves
 * whenever a chapter is added, renamed, opened or read, and it
 * is a few hundred bytes against the ledger's tens of thousands — cheap to
 * re-send, expensive to let invalidate a cached prefix.
 *
 * The active document stays here too. It is the most volatile object in the
 * app, and the edit protocol needs it adjacent to the request so SEARCH blocks
 * are copied from current bytes.
 */
export function buildVolatileTail(
  documents: RenderableDoc[],
  activeDocumentId: string | null,
  selectedText: string,
  preserveImages: (html: string) => string,
  opts?: DynamicContextOptions
): string {
  const chapterIndex = opts?.indexOverride ?? buildChapterIndex(documents, activeDocumentId, { agentTools: opts?.agentTools, markers: opts?.markers })
  const chapterIndexBlock = (chapterIndex ? `${chapterIndex}\n\n` : '') + (opts?.pinnedBlock ? `${opts.pinnedBlock}\n\n` : '')

  const activeDoc = documents.find(d => d.id === activeDocumentId)
  // Review markup must not reach the model: it copies `<ins class=
  // "diff-addition">` into an edit's search string, which stops matching the
  // instant the user accepts or rejects that diff (observed on a real turn).
  const cleanActiveContent = preserveImages(stripDiffMarkup(activeDoc?.content || ''))
  // …but what the pending changes REPLACED must, as now/was pairs, or "keep
  // what it said before" is a guess (utils/pendingChanges). Empty — the same
  // bytes as always — when nothing is pending.
  const pending = renderPendingChanges(pendingChanges(activeDoc?.content || ''))
  const pendingBlock = pending ? `\n\n${pending}` : ''

  if (selectedText) {
    const cleanSelectedText = preserveImages(selectedText)
    return `I have selected the following text in the document. I want you to focus your action on this specific text.
${chapterIndexBlock}
CURRENT SELECTED TEXT:
"""
${cleanSelectedText}
"""

CURRENT ACTIVE DOCUMENT CONTENT (For context):
"""
${cleanActiveContent}
"""${pendingBlock}`
  }
  if (opts?.activeOverride !== undefined) {
    return `Here is the current state of my document.
${chapterIndexBlock}
${opts.activeOverride}${pendingBlock}`
  }
  return `Here is the current state of my document.
${chapterIndexBlock}
CURRENT ACTIVE DOCUMENT CONTENT (${opts?.agentTools
    ? `Your writes change this chapter unless you name another${opts.activeCopyOlder ? '. Its copy under REFERENCED CHAPTERS is older: this is its current text' : ''}`
    : 'This is the ONLY document you can update'}):
"""
${cleanActiveContent}
"""${pendingBlock}`
}

// ── Context as differences (cache_continuity.md §3.2, §3.3) ─────────────────

/** Where a part's full copy went out: the turn (its reply's message id) whose transcript carries it. */
export interface SentPart { hash: string; turn: string }

/** What each part of the context last went out as, kept with the conversation's context state. */
export interface SentTail {
  index?: SentPart
  attachments?: SentPart
  active?: SentPart & { id: string }
  /** Pinned chapters sent in a tail (not in the ledger), by id. */
  pinned?: Record<string, SentPart>
}

export interface TailParts {
  /** The full chapter index block, as it would go out ('' when there is none). */
  index: string
  /** The full ATTACHMENTS block ('' when there is none). */
  attachments: string
  /**
   * The active chapter: id, number and title, and a hash of what its block
   * renders (its accepted text and label). Null when it must go out in full
   * whatever was sent before (a selection turn).
   */
  active: { id: string; number: number; title: string; hash: string } | null
}

/**
 * Each part in full, or one line saying it is unchanged — the line only
 * when the copy the model has went out in a turn whose transcript this
 * request replays (`present`). A turn summarized away, a reload, a missing
 * transcript: the full part again. So abbreviating never hides text; it
 * only stops copies piling up in the history (cache_continuity.md §3.2).
 * `active` comes back null when the full block goes out.
 */
export function diffTailParts(full: TailParts, previous: SentTail | null, present: string[], turn: string):
  { index: string; attachments: string; active: string | null; sent: SentTail } {
  const has = (p: SentPart | undefined, hash: string) => !!p && p.hash === hash && present.includes(p.turn)
  const sent: SentTail = {}
  let index = full.index
  if (full.index) {
    const hash = hashContent(full.index)
    if (has(previous?.index, hash)) {
      index = 'CHAPTER INDEX: unchanged since your last turn (the copy earlier in this conversation is current).'
      sent.index = previous!.index
    } else sent.index = { hash, turn }
  }
  let attachments = full.attachments
  if (full.attachments) {
    const hash = hashContent(full.attachments)
    if (has(previous?.attachments, hash)) {
      attachments = 'ATTACHMENTS: unchanged since your last turn (the list earlier in this conversation is current).'
      sent.attachments = previous!.attachments
    } else sent.attachments = { hash, turn }
  }
  let active: string | null = null
  if (full.active) {
    const a = full.active
    if (previous?.active?.id === a.id && has(previous.active, a.hash)) {
      active = `CURRENT ACTIVE DOCUMENT: #${a.number} "${a.title}" — unchanged since your last turn; its text is earlier in this conversation. Your writes change this chapter unless you name another.`
      sent.active = previous.active
    } else sent.active = { id: a.id, hash: a.hash, turn }
  }
  return { index, attachments, active, sent }
}

/** A pinned chapter as pinnedUpdates weighs it: `hash` as the ledger hashes it (the accepted HTML). */
export interface PinnedChapter { id: string; number: number; title: string; content: string; hash: string }

/**
 * Pinned chapters while the ledger is frozen (cache_continuity.md §3.3).
 * The latest copy of a chapter the model has is the one last sent in a tail
 * of a turn this request replays, else the ledger's. A pinned chapter whose
 * latest copy is missing or stale goes out in full in this turn's tail; one
 * no longer pinned is named once (`names`, by id), to be disregarded.
 * `keep` holds ids never to call unpinned (the open chapter: its text is in
 * the tail anyway).
 */
export function pinnedUpdates(
  pins: PinnedChapter[],
  ledger: Array<{ id: string; hash: string }>,
  previous: Record<string, SentPart> | null,
  present: string[],
  turn: string,
  names: Record<string, string>,
  keep: string[]
): { block: string; sent: Record<string, SentPart> } {
  const sent: Record<string, SentPart> = {}
  const blocks: string[] = []
  const pinnedIds = new Set(pins.map(p => p.id))
  const ledgerHash = (id: string) => [...ledger].reverse().find(e => e.id === id)?.hash
  const live = (id: string) => { const p = previous?.[id]; return p && present.includes(p.turn) ? p : undefined }
  for (const p of pins) {
    const prev = live(p.id)
    if (prev && prev.hash !== 'unpinned') {
      if (prev.hash === p.hash) { sent[p.id] = prev; continue }
    } else if (!prev && ledgerHash(p.id) === p.hash) continue
    const known = ledgerHash(p.id) !== undefined || (prev !== undefined && prev.hash !== 'unpinned')
    blocks.push(ledgerBlock({ id: p.id, title: `#${p.number} ${p.title}`, content: p.content }, known ? 'update' : 'fresh'))
    sent[p.id] = { hash: p.hash, turn }
  }
  const candidates = [...new Set([...ledger.map(e => e.id), ...Object.keys(previous ?? {})])].filter(id => !pinnedIds.has(id) && !keep.includes(id))
  const dropped: string[] = []
  for (const id of candidates) {
    const prev = live(id)
    if (prev?.hash === 'unpinned') { sent[id] = prev; continue }
    if (!prev && ledgerHash(id) === undefined) continue
    dropped.push(id)
    sent[id] = { hash: 'unpinned', turn }
  }
  const parts = blocks.length > 0 ? [`PINNED CHAPTERS — changed or pinned since the copy you have (each replaces any earlier copy):\n\n${blocks.join('\n')}`] : []
  if (dropped.length > 0) parts.push(`No longer pinned — disregard the earlier copies of: ${dropped.map(id => names[id] ?? id).join(', ')} (read them again if you need them).`)
  return { block: parts.join('\n\n'), sent }
}
