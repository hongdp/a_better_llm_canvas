import { htmlToPlainText } from './llmContext'

/**
 * Chapter index ("Layer 0") helpers: give the LLM whole-book awareness by
 * always sending a compact list of every chapter (title + short summary),
 * while full chapter text is attached separately on demand.
 *
 * Mirrors the skill pattern from agentic frameworks: the index line is the
 * chapter's metadata (always in context); the full text is its body (loaded
 * when needed). See docs/features/smart_context_selection.md.
 */

/** Minimal document shape the index helpers need. */
export interface IndexableDoc {
  id: string
  title: string
  content: string
  summary?: string
  summaryContentHash?: string
}

/** Max characters of a chapter's digest line inside the index block. */
const INDEX_DIGEST_MAX_CHARS = 400
/** Above this chapter count, digests are clamped harder to bound index size. */
const LARGE_BOOK_CHAPTER_THRESHOLD = 40
const LARGE_BOOK_DIGEST_MAX_CHARS = 150
/** Fallback digest length when a chapter has no generated summary yet. */
const FALLBACK_DIGEST_CHARS = 300
/**
 * One-line digest of a chapter for the index: the generated summary when
 * present (even if slightly stale — staleness is tolerated by design), else
 * the first chars of the plain text. Newlines are flattened so each chapter
 * stays a single readable entry.
 */
export function getChapterDigest(doc: IndexableDoc, maxChars: number = INDEX_DIGEST_MAX_CHARS): string {
  const source = doc.summary?.trim()
    ? doc.summary
    : htmlToPlainText(doc.content).slice(0, FALLBACK_DIGEST_CHARS)
  const flattened = source.replace(/\s*\n\s*/g, ' ').trim()
  if (flattened.length <= maxChars) return flattened
  return `${flattened.slice(0, maxChars)}…`
}

/**
 * Build the CHAPTER INDEX block sent with every request in a multi-chapter
 * book. Returns '' for single-document books, where an index says nothing.
 *
 * Lives in the dynamic context (final user message), NOT the system prompt:
 * the index churns whenever a summary regenerates, and the system prompt's
 * byte-stability is what provider prompt caching depends on.
 */
/** Options for the agentic loop (agentic_chat_loop.md D2, D6, D8). */
export interface ChapterIndexOptions {
  /** The model can write any chapter, so the active line must not say otherwise. */
  agentTools?: boolean
  /** Freshness markers by chapter id, e.g. "in context" (D8). */
  markers?: Record<string, string>
}

export function buildChapterIndex(
  documents: IndexableDoc[],
  activeDocumentId: string | null,
  options: ChapterIndexOptions = {}
): string {
  if (documents.length < 2) return ''
  const digestMax = documents.length > LARGE_BOOK_CHAPTER_THRESHOLD
    ? LARGE_BOOK_DIGEST_MAX_CHARS
    : INDEX_DIGEST_MAX_CHARS

  const lines = documents.map((doc, idx) => {
    const active = doc.id === activeDocumentId
    const marker = active
      ? options.agentTools
        ? ' [ACTIVE — open in the editor; writes go here unless you name another chapter]'
        : ' [ACTIVE — this is the document you can edit]'
      : ''
    const freshness = options.markers?.[doc.id] ? ` [${options.markers[doc.id]}]` : ''
    let digest = ''
    if (!active) {
      const text = getChapterDigest(doc, digestMax)
      // A chapter with no summary yet and no loaded text has nothing to show
      // but its title; say so, so the model knows the title is all it has
      // and reads or searches instead of guessing (D6).
      digest = text ? ` — ${text}` : options.agentTools ? ' — (not summarized yet)' : ' — '
    }
    return `${idx + 1}. "${doc.title}"${marker}${freshness}${digest}`
  })

  return `CHAPTER INDEX (all chapters in this book; full text NOT included unless it appears in REFERENCED DOCUMENT CONTEXTS or is the active document):
${lines.join('\n')}`
}

// ── analyze_book batch budgets ──────────────────────────────────────────────

/**
 * Approximate context-window budgets per provider, in characters (~4 chars
 * per token): how much chapter text one analyze_book batch carries
 * (agent/analyzeBook). Conservative: roughly 60%
 * of the window is left for the book, the rest for history, the active
 * document, instructions, and output.
 */
export const WHOLE_BOOK_CONTEXT_CHARS: Record<string, number> = {
  gemini: 2_400_000, // 1M-token window
  anthropic: 480_000, // 200k-token window
  openai: 300_000, // 128k-token window
  grok: 500_000, // large window; covers all but the biggest books in one call
  ollama: 80_000 // local models: assume small windows
}

/**
 * Pack chapters into batches for the Rung 2 map-reduce pass. Book order is
 * preserved; each batch fills greedily up to maxCharsPerBatch. A single
 * chapter larger than the budget gets its own batch (the prompt builder
 * truncates it with a notice).
 */
export function packChaptersIntoBatches<T extends { content: string }>(
  docs: T[],
  maxCharsPerBatch: number
): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let currentChars = 0
  for (const doc of docs) {
    const cost = doc.content.length
    if (current.length > 0 && currentChars + cost > maxCharsPerBatch) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(doc)
    currentChars += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}
