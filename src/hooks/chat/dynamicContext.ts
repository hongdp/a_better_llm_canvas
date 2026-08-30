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
import { useAppStore } from '../../store/useAppStore'
import { stripDiffMarkup } from '../../utils/diff'
import { truncateWithNotice, htmlToPlainText } from '../../utils/llmContext'
import { buildChapterIndex, buildWholeBookDigest } from '../../utils/chapterIndex'
import type { LLMMessage } from '../../types/llm'

// Per-document cap for read-only reference documents attached as context.
const MAX_REFERENCE_DOC_CHARS = 20_000

/**
 * Whole-book options: `perDocChars` lifts the per-doc cap for Rung 1
 * attach-all; `includeWholeBookDigest` swaps the compact index for the full
 * structural digest (fast mode); `notesBlock` carries Rung 2 batch notes.
 */
export interface DynamicContextOptions {
  perDocChars?: number
  includeWholeBookDigest?: boolean
  notesBlock?: string
}

/** One chapter as it is rendered into the ledger block. */
export function renderLedgerChapter(title: string, content: string, perDocChars: number): string {
  return `--- DOCUMENT: ${title} ---\n${truncateWithNotice(htmlToPlainText(content), perDocChars)}\n`
}

/**
 * The stable, append-only block of reference chapters, injected ahead of the
 * chat history as a user/assistant pair — the same shape `buildStickyBookPrefix`
 * uses for whole-book mode, and for the same reason: providers cache a prefix,
 * not a set of fields.
 *
 * Returns [] for an empty ledger so the caller can spread it unconditionally.
 */
export function buildLedgerMessages(
  ledgerIds: string[],
  perDocChars: number = MAX_REFERENCE_DOC_CHARS
): LLMMessage[] {
  if (ledgerIds.length === 0) return []
  const s = useAppStore.getState()

  const chapters = ledgerIds
    .map(id => {
      const doc = s.documents.find(d => d.id === id)
      return doc ? renderLedgerChapter(doc.title, doc.content, perDocChars) : ''
    })
    .filter(Boolean)
    .join('\n')

  if (!chapters) return []

  return [
    {
      role: 'user',
      content: `REFERENCED CHAPTERS (read-only; use them for details and consistency, never edit them):\n\n${chapters}`,
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
 * whenever any chapter's title or background-refreshed summary moves, and it
 * is a few hundred bytes against the ledger's tens of thousands — cheap to
 * re-send, expensive to let invalidate a cached prefix.
 *
 * The active document stays here too. It is the most volatile object in the
 * app, and the edit protocol needs it adjacent to the request so SEARCH blocks
 * are copied from current bytes.
 */
export function buildVolatileTail(
  selectedText: string,
  preserveImages: (html: string) => string,
  opts?: DynamicContextOptions
): string {
  const s = useAppStore.getState()

  const chapterIndex = opts?.includeWholeBookDigest
    ? buildWholeBookDigest(s.documents, s.activeDocumentId)
    : buildChapterIndex(s.documents, s.activeDocumentId)
  let chapterIndexBlock = chapterIndex ? `${chapterIndex}\n\n` : ''
  if (opts?.notesBlock) {
    chapterIndexBlock += `BOOK ANALYSIS NOTES (compiled by reading every chapter of this book in batches for this request — treat them as your own reading of the full text):\n${opts.notesBlock}\n\n`
  }

  const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
  // Review markup must not reach the model: it copies `<ins class=
  // "diff-addition">` into an edit's search string, which stops matching the
  // instant the user accepts or rejects that diff (observed on a real turn).
  const cleanActiveContent = preserveImages(stripDiffMarkup(activeDoc?.content || ''))

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
"""`
  }
  return `Here is the current state of my document.
${chapterIndexBlock}
CURRENT ACTIVE DOCUMENT CONTENT (This is the ONLY document you can update):
"""
${cleanActiveContent}
"""`
}

/**
 * Whole-book Rung 1 (attach-all, non-sticky) still inlines every chapter into
 * the final user message: it is a one-shot request whose content is chosen per
 * call, so there is no cross-turn prefix to protect.
 */
export function buildInlineReferenceBlock(
  referenceIds: string[],
  perDocChars: number
): string {
  const s = useAppStore.getState()
  const body = referenceIds
    .map(id => {
      const doc = s.documents.find(d => d.id === id)
      return doc ? renderLedgerChapter(doc.title, doc.content, perDocChars) : ''
    })
    .filter(Boolean)
    .join('\n')
  return body
    ? `\nREFERENCED DOCUMENT CONTEXTS (Read-only, do not modify these but use them for details/consistency):\n${body}`
    : ''
}
