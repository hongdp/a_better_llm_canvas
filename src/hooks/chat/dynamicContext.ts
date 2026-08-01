/**
 * Volatile document-context assembly for a chat request (reference docs +
 * active doc). Parameterized on the current selection and the per-request
 * image-placeholder transform so it needs none of the hook's refs.
 */
import { useAppStore } from '../../store/useAppStore'
import { truncateWithNotice, htmlToPlainText } from '../../utils/llmContext'
import { buildChapterIndex, buildWholeBookDigest } from '../../utils/chapterIndex'

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

// Build the volatile document context (reference docs + active doc).
// Returned as a string that is merged into the FINAL user message: keeping
// it after the (stable) chat history preserves provider prompt-cache
// prefixes across turns, and keeps the document close to the request so
// <edit> SEARCH blocks are copied from nearby, current content.
export function buildDynamicContext(
  finalReferenceIds: string[],
  selectedText: string,
  preserveImages: (html: string) => string,
  opts?: DynamicContextOptions
): string {
  const s = useAppStore.getState()

  // Layer 0: compact index of every chapter (title + summary digest) so the
  // model always has whole-book awareness even for unattached chapters.
  // Empty for single-document books.
  const chapterIndex = opts?.includeWholeBookDigest
    ? buildWholeBookDigest(s.documents, s.activeDocumentId)
    : buildChapterIndex(s.documents, s.activeDocumentId)
  let chapterIndexBlock = chapterIndex ? `${chapterIndex}\n\n` : ''
  if (opts?.notesBlock) {
    chapterIndexBlock += `BOOK ANALYSIS NOTES (compiled by reading every chapter of this book in batches for this request — treat them as your own reading of the full text):\n${opts.notesBlock}\n\n`
  }

  // Build context string for explicitly selected secondary documents
  const perDocCap = opts?.perDocChars ?? MAX_REFERENCE_DOC_CHARS
  const referenceDocsContext = finalReferenceIds
    .map(id => {
      const doc = s.documents.find(d => d.id === id)
      if (!doc) return ''
      const textContent = truncateWithNotice(htmlToPlainText(doc.content), perDocCap)
      return `--- DOCUMENT: ${doc.title} ---\n${textContent}\n`
    })
    .filter(Boolean)
    .join('\n')

  const activeDoc = s.documents.find(d => d.id === s.activeDocumentId)
  const cleanActiveContent = preserveImages(activeDoc?.content || '')

  if (selectedText) {
    const cleanSelectedText = preserveImages(selectedText)
    return `I have selected the following text in the document. I want you to focus your action on this specific text.
${chapterIndexBlock}${referenceDocsContext ? `\nREFERENCED DOCUMENT CONTEXTS (Read-only, do not modify these but use them for details/consistency):\n${referenceDocsContext}` : ''}
CURRENT SELECTED TEXT:
"""
${cleanSelectedText}
"""

CURRENT ACTIVE DOCUMENT CONTENT (For context):
"""
${cleanActiveContent}
"""`
  } else {
    return `Here is the current state of my document.
${chapterIndexBlock}${referenceDocsContext ? `\nREFERENCED DOCUMENT CONTEXTS (Read-only, do not modify these but use them for details/consistency):\n${referenceDocsContext}` : ''}

CURRENT ACTIVE DOCUMENT CONTENT (This is the ONLY document you can update):
"""
${cleanActiveContent}
"""`
  }
}
