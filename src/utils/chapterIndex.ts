import { tokensToChars } from './contextWindow'

/**
 * The CHAPTER INDEX: every chapter of the book by number and title, which one
 * is open, and what the model has seen of each (freshness markers, D8). Built
 * from the chapter list on every request, so it is never stale.
 *
 * It no longer carries a per-chapter summary or digest (2026-10-11): their
 * generation was removed on 2026-08-29, the stored summaries went stale as
 * chapters changed, and three had been copied onto another book's chapter of
 * the same id. The model reads or greps a chapter when it needs its text, and
 * `list` gives each chapter's size.
 */

/** Minimal document shape the index helpers need. */
export interface IndexableDoc {
  id: string
  title: string
  content: string
}

/** Options for the agentic loop (agentic_chat_loop.md D2, D6, D8). */
export interface ChapterIndexOptions {
  /** The model can write any chapter, so the active line must not say otherwise. */
  agentTools?: boolean
  /** Freshness markers by chapter id, e.g. "in context" (D8). */
  markers?: Record<string, string>
}

/**
 * Build the CHAPTER INDEX block sent with every request in a multi-chapter
 * book. Returns '' for single-document books, where an index says nothing.
 * It lives in the dynamic context (final user message), not the system prompt.
 */
export function buildChapterIndex(
  documents: IndexableDoc[],
  activeDocumentId: string | null,
  options: ChapterIndexOptions = {}
): string {
  if (documents.length < 2) return ''
  const lines = documents.map((doc, idx) => {
    const active = doc.id === activeDocumentId
    const marker = active
      ? options.agentTools
        ? ' [ACTIVE — open in the editor; writes go here unless you name another chapter]'
        : ' [ACTIVE — this is the document you can edit]'
      : ''
    const freshness = options.markers?.[doc.id] ? ` [${options.markers[doc.id]}]` : ''
    return `${idx + 1}. "${doc.title}"${marker}${freshness}`
  })

  return `CHAPTER INDEX (all chapters in this book; full text NOT included unless it appears in REFERENCED DOCUMENT CONTEXTS or is the active document):
${lines.join('\n')}`
}

// ── analyze_book batch budgets ──────────────────────────────────────────────

/**
 * Tokens of chapter text one analyze_book batch carries, per provider.
 *
 * Problem: the budget was characters at ~4 per token — 500,000 for grok. A
 *   Chinese novel is about one token per character, so a batch was 350–420k
 *   tokens: past grok's 200k long-context price line on every call
 *   (run-737f3d809b45: 1.58M tokens for one analyze_book).
 * Fix: budget in tokens, under each provider's window AND price line, with
 *   room for the running notes, the task and the reply; converted to
 *   characters by the text's own CJK share (tokensToChars).
 */
export const ANALYZE_BATCH_TOKENS: Record<string, number> = {
  gemini: 140_000, // 1M window; long-context price above 200k
  anthropic: 120_000, // 200k window
  openai: 80_000, // 128k window
  grok: 140_000, // long-context price above 200k
  ollama: 20_000 // local models: assume small windows
}

/** Characters of chapter text per analyze_book batch, for text with this share of CJK. */
export function analyzeBatchChars(provider: string, cjkRatio: number): number {
  return tokensToChars(ANALYZE_BATCH_TOKENS[provider] ?? 80_000, cjkRatio)
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
