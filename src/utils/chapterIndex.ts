import { htmlToPlainText, truncateWithNotice } from './llmContext'

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
/** Chapters shorter than this never need an LLM summary — a text sample is enough. */
export const MIN_CHARS_FOR_SUMMARY = 1000

/**
 * FNV-1a 32-bit content hash, hex-encoded. Not cryptographic — only used to
 * detect that a document's content changed since its summary was generated.
 */
export function hashDocumentContent(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** A summary is stale when the content no longer matches the hash it was made from. */
export function isSummaryStale(doc: Pick<IndexableDoc, 'content' | 'summary' | 'summaryContentHash'>): boolean {
  if (!doc.summary) return true
  return doc.summaryContentHash !== hashDocumentContent(doc.content)
}

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
 * book. Returns '' for single-document books (no index, no lookup surface).
 *
 * Lives in the dynamic context (final user message), NOT the system prompt:
 * the index churns whenever a summary regenerates, and the system prompt's
 * byte-stability is what provider prompt caching depends on.
 */
export function buildChapterIndex(documents: IndexableDoc[], activeDocumentId: string | null): string {
  if (documents.length < 2) return ''
  const digestMax = documents.length > LARGE_BOOK_CHAPTER_THRESHOLD
    ? LARGE_BOOK_DIGEST_MAX_CHARS
    : INDEX_DIGEST_MAX_CHARS

  const lines = documents.map((doc, idx) => {
    const active = doc.id === activeDocumentId
    const marker = active ? ' [ACTIVE — this is the document you can edit]' : ''
    const digest = active ? '' : ` — ${getChapterDigest(doc, digestMax)}`
    return `${idx + 1}. "${doc.title}"${marker}${digest}`
  })

  return `CHAPTER INDEX (all chapters in this book; full text NOT included unless it appears in REFERENCED DOCUMENT CONTEXTS or is the active document):
${lines.join('\n')}`
}

/**
 * Plain-text sample of a chapter used as the summarizer's input, capped so a
 * giant chapter can't blow up the (cheap) summary call.
 */
export function buildSummaryInput(doc: IndexableDoc, maxChars: number = 30_000): string {
  return truncateWithNotice(htmlToPlainText(doc.content), maxChars)
}

// ── Whole-book mode helpers (escalation ladder, spec §6) ─────────────────────

/**
 * Extract a chapter's heading tree (h1–h3) from its stored HTML — the free
 * "Rung 0" structural digest. Deterministic, zero LLM cost; for
 * outline-shaped tasks this is most of the signal.
 */
export function extractHeadingTree(html: string): string {
  const lines: string[] = []
  for (const match of html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const level = Number(match[1])
    const text = htmlToPlainText(match[2]).replace(/\s+/g, ' ').trim()
    if (text) lines.push(`${'  '.repeat(level - 1)}- ${text}`)
  }
  return lines.join('\n')
}

/**
 * Rung 0 material: heading tree + summary for every chapter. Sent when
 * whole-book mode runs in "fast mode" (or alongside batched processing) so
 * the model sees the full book structure without full text.
 */
export function buildWholeBookDigest(documents: IndexableDoc[], activeDocumentId: string | null): string {
  const sections = documents.map((doc, idx) => {
    const active = doc.id === activeDocumentId ? ' (ACTIVE)' : ''
    const headings = extractHeadingTree(doc.content)
    const digest = getChapterDigest(doc)
    return `${idx + 1}. "${doc.title}"${active}\n${headings ? `${headings}\n` : ''}Summary: ${digest}`
  })
  return `WHOLE-BOOK DIGEST (structure and summaries of every chapter; full text NOT included):\n${sections.join('\n\n')}`
}

/**
 * Approximate context-window budgets per provider, in characters (~4 chars
 * per token), used to decide whether a whole book fits a single request
 * (Rung 1) or needs batched processing (Rung 2). Conservative: roughly 60%
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
