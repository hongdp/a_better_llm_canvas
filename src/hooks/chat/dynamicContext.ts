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
  summary?: string
}

export interface DynamicContextOptions {
  /** The agentic loop's tools are on: the model may write any chapter. */
  agentTools?: boolean
  /** Freshness markers for the chapter index (agentic_chat_loop.md D8). */
  markers?: Record<string, string>
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
    ? 'REFERENCED CHAPTERS (full text, as plain text, for details and consistency; to change one, read its HTML with read_chapter and name it in your write):'
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
 * whenever any chapter's title or background-refreshed summary moves, and it
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
  const chapterIndex = buildChapterIndex(documents, activeDocumentId, { agentTools: opts?.agentTools, markers: opts?.markers })
  const chapterIndexBlock = chapterIndex ? `${chapterIndex}\n\n` : ''

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
  return `Here is the current state of my document.
${chapterIndexBlock}
CURRENT ACTIVE DOCUMENT CONTENT (${opts?.agentTools
    ? 'Your writes change this chapter unless you name another'
    : 'This is the ONLY document you can update'}):
"""
${cleanActiveContent}
"""${pendingBlock}`
}
