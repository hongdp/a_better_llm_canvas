import { detectReferencedDocIds } from './llmContext'

/**
 * Context auto-selection ("Layer 1") — a deterministic, LLM-free scorer that
 * decides which chapters to attach as read-only reference context for a chat
 * request. Runs on debounced keystrokes to preview the selection in the tag
 * bar, and again at send time. See docs/features/smart_context_selection.md §4.
 *
 * Control precedence: pinned > blocked > auto > index-only. Manual choices
 * are never overridden by automation.
 */

export interface SelectableDoc {
  id: string
  title: string
  content: string
  summary?: string
  contentLoaded?: boolean
}

export interface SelectionInput {
  /** The prompt currently being written/sent. */
  promptText: string
  /** Recent chat message texts, most recent LAST. Only the tail is scanned. */
  recentHistory: string[]
  /** All documents in book order. */
  documents: SelectableDoc[]
  activeDocumentId: string | null
  /** User-pinned chapter ids (always attached). */
  pinnedIds: string[]
  /** User-blocked chapter ids (never auto-attached). */
  blockedIds: string[]
  /** Chapters attached on the previous turn (conversation continuity). */
  previousAttachedIds?: string[]
  /**
   * Chapters already in the context ledger — sent on an earlier turn and
   * therefore already inside the model's cached prefix. They stay attached
   * for free (no budget, no re-scoring); dropping one costs a re-prefill and
   * is the user's call, not the scorer's. See contextLedger.ts.
   */
  ledgerIds?: string[]
}

export interface SelectionOptions {
  /** Total char budget across all attached reference docs. */
  maxTotalChars?: number
  /** Per-document char cap (mirrors MAX_REFERENCE_DOC_CHARS truncation). */
  perDocChars?: number
  /** Minimum score for auto-attachment. */
  scoreThreshold?: number
}

export interface SelectionResult {
  /**
   * Every chapter this turn wants attached: the ledger's members (minus any
   * the user blocked) plus this turn's admissions. This is a SET, not a
   * layout — `planLedgerTurn` decides the order, which is why nothing here
   * sorts by score any more.
   */
  attachedIds: string[]
  /** The auto-selected subset of attachedIds. */
  autoIds: string[]
  /** Auto candidates that qualified on score but were dropped by the budget. */
  droppedForBudget: string[]
  /** Per-doc scores, for tooltips/debug. */
  scores: Record<string, number>
  /** Estimated chars of all attached docs (after per-doc capping). */
  estimatedChars: number
}

export const DEFAULT_SELECTION_OPTIONS: Required<SelectionOptions> = {
  maxTotalChars: 60_000,
  perDocChars: 20_000,
  scoreThreshold: 40
}

const SCORE_TITLE_IN_PROMPT = 100
const SCORE_TITLE_IN_HISTORY = 60
const SCORE_ADJACENT = 40
const SCORE_PREVIOUS_TURN = 30
const SCORE_KEYWORD_MAX = 50
const SCORE_PER_KEYWORD_HIT = 10
const HISTORY_TAIL_MESSAGES = 4

const LATIN_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'what', 'when', 'where', 'which',
  'about', 'chapter', 'please', 'write', 'make', 'more', 'them', 'they',
  'will', 'would', 'could', 'should', 'into', 'your', 'their'
])

/**
 * Extract match keywords from a prompt: latin words (≥4 chars, minus
 * stopwords) plus CJK bigrams, so Chinese/Japanese prompts score overlap
 * without word segmentation. Capped to bound the per-doc scan cost.
 */
export function extractKeywords(text: string, cap = 80): string[] {
  const keywords = new Set<string>()
  const lower = text.toLowerCase()

  for (const match of lower.matchAll(/[a-z0-9]{4,}/g)) {
    if (!LATIN_STOPWORDS.has(match[0])) keywords.add(match[0])
    if (keywords.size >= cap) return [...keywords]
  }

  // CJK bigrams from runs of CJK characters.
  for (const run of lower.matchAll(/[一-鿿぀-ヿ]{2,}/g)) {
    const chars = run[0]
    for (let i = 0; i < chars.length - 1; i++) {
      keywords.add(chars.slice(i, i + 2))
      if (keywords.size >= cap) return [...keywords]
    }
  }

  return [...keywords]
}

/** Chars a doc contributes to the request after per-doc truncation. */
const docCost = (doc: SelectableDoc, perDocChars: number): number =>
  Math.min(doc.content.length, perDocChars)

/**
 * Score every non-active chapter and pick what to attach under the budget.
 *
 * Guarantees:
 * - Pinned docs are always attached (they consume budget but are never
 *   dropped — an explicit user choice may exceed the budget).
 * - Blocked docs never auto-attach.
 * - Docs whose content isn't loaded yet (server lazy-loading) or is empty
 *   are never attached — there is nothing to send; their index line still
 *   gives the model awareness. Callers that need a doc's content attached
 *   (pins at send time, whole-book) must await the store's
 *   ensureDocumentContents() BEFORE calling this, or the doc is silently
 *   dropped here (this scorer is sync and cannot fetch).
 * - A wrong selection degrades to the chapter's index line, never to nothing.
 */
export function selectReferenceChapters(
  input: SelectionInput,
  options: SelectionOptions = {}
): SelectionResult {
  const { maxTotalChars, perDocChars, scoreThreshold } = { ...DEFAULT_SELECTION_OPTIONS, ...options }
  const { promptText, recentHistory, documents, activeDocumentId, pinnedIds, blockedIds } = input
  const previousAttachedIds = input.previousAttachedIds ?? []
  const ledgerIds = input.ledgerIds ?? []

  const candidates = documents.filter(d => d.id !== activeDocumentId)
  const attachable = (d: SelectableDoc) => d.contentLoaded !== false && d.content.length > 0

  // Signal: title mentioned in the prompt / recent history.
  const historyText = recentHistory.slice(-HISTORY_TAIL_MESSAGES).join('\n')
  const mentionedInPrompt = new Set(detectReferencedDocIds(promptText, candidates, activeDocumentId))
  const mentionedInHistory = new Set(detectReferencedDocIds(historyText, candidates, activeDocumentId))

  // Signal: adjacency to the active chapter in book order.
  const activeIdx = documents.findIndex(d => d.id === activeDocumentId)
  const adjacentIds = new Set<string>()
  if (activeIdx !== -1) {
    if (documents[activeIdx - 1]) adjacentIds.add(documents[activeIdx - 1].id)
    if (documents[activeIdx + 1]) adjacentIds.add(documents[activeIdx + 1].id)
  }

  // Signal: keyword overlap between the prompt and each chapter's digest.
  const keywords = extractKeywords(promptText)

  const scores: Record<string, number> = {}
  for (const doc of candidates) {
    let score = 0
    if (mentionedInPrompt.has(doc.id)) score += SCORE_TITLE_IN_PROMPT
    if (mentionedInHistory.has(doc.id)) score += SCORE_TITLE_IN_HISTORY
    if (adjacentIds.has(doc.id)) score += SCORE_ADJACENT
    // Continuity only needs a nudge for candidates that are NOT already in
    // the ledger; a ledger member is kept regardless, and scoring it here
    // would only distort which NEW chapter wins the remaining budget.
    if (!ledgerIds.includes(doc.id) && previousAttachedIds.includes(doc.id)) score += SCORE_PREVIOUS_TURN
    if (keywords.length > 0) {
      const digest = `${doc.title}\n${doc.summary ?? ''}`.toLowerCase()
      let hits = 0
      for (const kw of keywords) {
        if (digest.includes(kw)) hits++
      }
      score += Math.min(SCORE_KEYWORD_MAX, hits * SCORE_PER_KEYWORD_HIT)
    }
    scores[doc.id] = score
  }

  // Ledger members ride along for free: their bytes are already in the
  // model's cached prefix, so they cost no budget this turn. A blocked one is
  // the user asking for it to go — the ledger planner turns that into a
  // consent prompt rather than a silent eviction.
  const keptLedgerIds = ledgerIds.filter(id => !blockedIds.includes(id) && id !== activeDocumentId)

  // Pinned: always attached, in book order.
  const pinnedDocs = candidates.filter(d =>
    pinnedIds.includes(d.id) && attachable(d) && !keptLedgerIds.includes(d.id)
  )
  let usedChars = pinnedDocs.reduce((sum, d) => sum + docCost(d, perDocChars), 0)

  // Autos: qualified by score, greedy by score under the remaining budget.
  const autoCandidates = candidates
    .filter(d =>
      !pinnedIds.includes(d.id) &&
      !blockedIds.includes(d.id) &&
      attachable(d) &&
      !keptLedgerIds.includes(d.id) &&
      scores[d.id] >= scoreThreshold
    )
    .sort((a, b) => scores[b.id] - scores[a.id])

  const autoIds: string[] = []
  const droppedForBudget: string[] = []
  for (const doc of autoCandidates) {
    const cost = docCost(doc, perDocChars)
    if (usedChars + cost <= maxTotalChars) {
      autoIds.push(doc.id)
      usedChars += cost
    } else {
      droppedForBudget.push(doc.id)
    }
  }

  return {
    attachedIds: [...keptLedgerIds, ...pinnedDocs.map(d => d.id), ...autoIds],
    autoIds,
    droppedForBudget,
    scores,
    estimatedChars: usedChars
  }
}
