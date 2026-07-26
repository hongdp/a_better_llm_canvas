import type { LLMMessage } from '../types/llm'

/**
 * Options for trimming chat history before sending it to an LLM.
 */
export interface TrimHistoryOptions {
  /** Approximate character budget for the whole history window. */
  maxChars: number
  /** Always keep at least this many of the most recent messages. */
  minKeepMessages?: number
  /**
   * Only the last N messages of the returned window keep their images.
   * Older base64 images are stripped — they dominate token cost and are
   * rarely needed after the turn they were sent in.
   */
  keepImagesInLast?: number
}

/**
 * Trim chat history to a character budget, keeping the most recent messages.
 *
 * Guarantees:
 * - Messages are returned in their original order.
 * - At least `minKeepMessages` recent messages survive regardless of budget.
 * - Images are stripped from all but the last `keepImagesInLast` messages.
 * - Empty messages (no text, no images) are dropped — they carry no signal
 *   and Anthropic rejects empty text blocks.
 * - Consecutive same-role messages are merged into one turn, so a dropped
 *   message in between never produces a user/user or assistant/assistant
 *   sequence that stricter providers reject.
 * - The window never starts with an assistant message (providers such as
 *   Anthropic and Gemini require the first non-system turn to be a user
 *   turn), so leading assistant messages after trimming are dropped.
 */
export function trimHistoryForContext(
  messages: LLMMessage[],
  options: TrimHistoryOptions
): LLMMessage[] {
  const { maxChars, minKeepMessages = 2, keepImagesInLast = 4 } = options

  const kept: LLMMessage[] = []
  let usedChars = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg.content.trim() && !(msg.images && msg.images.length > 0)) {
      continue
    }
    const cost = msg.content.length
    const mustKeep = kept.length < minKeepMessages
    if (!mustKeep && usedChars + cost > maxChars) {
      break
    }
    usedChars += cost
    kept.unshift({ ...msg })
  }

  // Drop leading assistant messages so the window starts with a user turn.
  while (kept.length > 0 && kept[0].role === 'assistant') {
    kept.shift()
  }

  // Merge consecutive same-role turns (possible after empty messages were
  // dropped above). `kept` holds shallow copies, so mutation is safe.
  const merged: LLMMessage[] = []
  for (const msg of kept) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === msg.role) {
      prev.content = `${prev.content}\n\n${msg.content}`.trim()
      if (msg.images && msg.images.length > 0) {
        prev.images = [...(prev.images ?? []), ...msg.images]
      }
    } else {
      merged.push(msg)
    }
  }

  // Strip images from all but the most recent messages.
  const imageCutoff = merged.length - keepImagesInLast
  return merged.map((msg, idx) => {
    if (idx < imageCutoff && msg.images) {
      const rest = { ...msg }
      delete rest.images
      return rest
    }
    return msg
  })
}

/**
 * Remove display-only artifacts from a stored chat message before feeding it
 * back to the LLM as history:
 * - Leading "[Attached Context: <title>]" lines the UI prepends to replies.
 * - Trailing "⚠️ …" status notes the client appends (canvas truncated/elided,
 *   unmatched <edit> blocks, stream errors, the no-document-content notice). These are the app talking to the
 *   user, not something the model said — feeding them back teaches the model
 *   to imitate them or apologize for failures it didn't emit.
 * - "📖 …" / "📚 …" / "🔁 …" status bubbles left behind when an agentic lookup,
 *   a whole-book batch pass, or a no-action retry was aborted mid-round — pure
 *   UI state, never something the model said.
 * The result may be empty (e.g. a pure error message); callers rely on
 * `trimHistoryForContext` dropping empty messages.
 */
export function stripChatDisplayArtifacts(content: string): string {
  let out = content.replace(/^(?:\[Attached Context: [^\]\n]*\]\n?)+\n*/, '')
  out = out.replace(
    /(?:^|\n+)⚠️ (?:Error(?: during stream)?:|The response was cut off|The response abbreviated|The model answered without|\d+ suggested changes? could not be located)[\s\S]*$/,
    ''
  )
  out = out.replace(/^[📖📚🔁] [^\n]*\n?/gmu, '')
  return out.trim()
}

/**
 * Convert stored document HTML into readable plain text for LLM context:
 * block-level boundaries become newlines (so headings/paragraphs/list items
 * don't fuse into one run-on line) and common HTML entities are decoded.
 * Use this for read-only context (reference docs, world lore, game state) —
 * NOT for the active document, whose verbatim HTML the <edit> protocol needs.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6]|li|blockquote|div|tr|pre)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>?/gm, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&') // decode last so "&amp;lt;" stays a literal "&lt;"
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Minimal shape of a document for reference detection/labelling. */
export interface ReferenceDocLike {
  id: string
  title: string
}

/**
 * Detect documents the prompt refers to by title so they can be auto-attached
 * as read-only context. A match is either the full title or the title with a
 * "Chapter N:" prefix removed. Very short titles are ignored — a one-letter
 * title would substring-match almost any prompt and attach unrelated
 * documents, silently bloating the context.
 */
export function detectReferencedDocIds(
  promptText: string,
  documents: ReferenceDocLike[],
  activeDocumentId: string | null
): string[] {
  const prompt = promptText.toLowerCase()
  const ids: string[] = []
  for (const doc of documents) {
    if (doc.id === activeDocumentId) continue
    const title = doc.title.trim().toLowerCase()
    const cleanTitle = title.replace(/chapter\s*\d+\s*:\s*/g, '').trim()
    if (
      (title.length > 1 && prompt.includes(title)) ||
      (cleanTitle.length > 3 && prompt.includes(cleanTitle))
    ) {
      ids.push(doc.id)
    }
  }
  return ids
}

/**
 * Resolve chapter titles from a <lookup> request to document ids. Matching is
 * fuzzy in the same spirit as detectReferencedDocIds: exact normalized title
 * first, then substring containment either way (with a minimum length so a
 * one-word title can't match everything). Returns ids in request order,
 * deduplicated, active document excluded.
 */
export function resolveLookupTitles(
  titles: string[],
  documents: ReferenceDocLike[],
  activeDocumentId: string | null
): string[] {
  const ids: string[] = []
  for (const rawTitle of titles) {
    const query = rawTitle.trim().toLowerCase()
    if (query.length < 2) continue
    let match = documents.find(d => d.id !== activeDocumentId && d.title.trim().toLowerCase() === query)
    if (!match && query.length > 3) {
      match = documents.find(d => {
        if (d.id === activeDocumentId) return false
        const title = d.title.trim().toLowerCase()
        return title.length > 3 && (title.includes(query) || query.includes(title))
      })
    }
    if (match && !ids.includes(match.id)) ids.push(match.id)
  }
  return ids
}

/**
 * Build the "[Attached Context: <title>]" label block shown above assistant
 * replies for auto/selected reference documents. Ids listed in `autoIds` are
 * marked "(auto)" so the user can tell scorer picks from their own pins.
 */
export function buildAttachmentsLabel(
  ids: string[],
  documents: ReferenceDocLike[],
  autoIds: string[] = []
): string {
  return ids
    .map(id => {
      const doc = documents.find(d => d.id === id)
      if (!doc) return ''
      return `[Attached Context: ${doc.title}${autoIds.includes(id) ? ' (auto)' : ''}]`
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Truncate long reference text to a character budget, appending an explicit
 * notice so the model knows the content is incomplete rather than silently
 * ending mid-sentence.
 */
export function truncateWithNotice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…[truncated: showing first ${maxChars} of ${text.length} characters]`
}
