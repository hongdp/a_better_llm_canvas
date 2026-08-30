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
   * Carry images on history messages. Default false: a history message that
   * gains or loses images changes bytes the model already saw, which ends the
   * cached prefix there. The current turn's images travel on the final user
   * message instead, which is volatile by design.
   */
  keepImages?: boolean
}

/**
 * Trim chat history to a character budget, keeping the most recent messages.
 *
 * Problem (cache): every message this returns is a message the model has
 *   already seen. If its bytes differ from the last turn's, the provider's
 *   cached prefix ends there and everything after it is prefilled again. Two
 *   details used to do exactly that: same-role merging ran AFTER trimming, so
 *   a message's content depended on where the window happened to start, and
 *   images were kept on a ROLLING last-N offset, so a message silently lost
 *   its images as the conversation advanced past it.
 * Fix: normalize first, on the whole history, so a given message renders the
 *   same bytes regardless of the window; then cut whole messages from the
 *   front. Images are carried only by the turn that attached them.
 *
 * Guarantees:
 * - Messages are returned in their original order.
 * - At least `minKeepMessages` recent messages survive regardless of budget.
 * - A message's bytes never depend on the window's start.
 * - Empty messages (no text, no images) are dropped — they carry no signal
 *   and Anthropic rejects empty text blocks.
 * - Consecutive same-role messages are merged into one turn, so a dropped
 *   message in between never produces a user/user or assistant/assistant
 *   sequence that stricter providers reject.
 * - The window never starts with an assistant message (providers such as
 *   Anthropic and Gemini require the first non-system turn to be a user
 *   turn), so leading assistant messages after trimming are dropped.
 */
/** Stands in for an image that has already been sent, in history. */
export const IMAGE_PLACEHOLDER_TEXT = '[image sent earlier in this conversation]'

export function trimHistoryForContext(
  messages: LLMMessage[],
  options: TrimHistoryOptions
): LLMMessage[] {
  const { maxChars, minKeepMessages = 2, keepImages = false } = options

  // 1. Normalize the WHOLE history first: drop empties, merge same-role runs,
  //    settle images. Doing this before the budget cut is what makes a
  //    message's bytes independent of where the window starts.
  const normalized: LLMMessage[] = []
  for (const msg of messages) {
    if (!msg.content.trim() && !(msg.images && msg.images.length > 0)) continue
    const carried: LLMMessage = { ...msg }
    if (!keepImages && carried.images) {
      // Images ride along only in the turn that attached them; in history they
      // would keep changing the bytes of a message the model already saw, and
      // base64 dominates the token cost besides. A message that was NOTHING
      // but an image keeps a placeholder rather than vanishing — dropping it
      // would delete a turn from the conversation and can merge the two
      // assistant turns around it.
      delete carried.images
      if (!carried.content.trim()) carried.content = IMAGE_PLACEHOLDER_TEXT
    }
    const prev = normalized[normalized.length - 1]
    if (prev && prev.role === carried.role) {
      prev.content = `${prev.content}\n\n${carried.content}`.trim()
      if (carried.images && carried.images.length > 0) {
        prev.images = [...(prev.images ?? []), ...carried.images]
      }
      continue
    }
    normalized.push(carried)
  }

  // 2. Cut whole messages from the front, newest-first, until the budget is met.
  const kept: LLMMessage[] = []
  let usedChars = 0
  for (let i = normalized.length - 1; i >= 0; i--) {
    const msg = normalized[i]
    const mustKeep = kept.length < minKeepMessages
    if (!mustKeep && usedChars + msg.content.length > maxChars) break
    usedChars += msg.content.length
    kept.unshift(msg)
  }

  // 3. Drop leading assistant messages so the window starts with a user turn.
  while (kept.length > 0 && kept[0].role === 'assistant') {
    kept.shift()
  }

  return kept
}

/**
 * Remove display-only artifacts from a stored chat message before feeding it
 * back to the LLM as history:
 * - Leading "[Attached Context: <title>]" lines the UI prepends to replies.
 * - Trailing "⚠️ …" status notes the client appends (canvas truncated/elided,
 *   unmatched <edit> blocks, stream errors, the no-document-content notice). These are the app talking to the
 *   user, not something the model said — feeding them back teaches the model
 *   to imitate them or apologize for failures it didn't emit.
 * - "📚 …" / "🔁 …" status bubbles left behind when a whole-book batch pass or
 *   a no-action retry was aborted mid-round — pure UI state, never something
 *   the model said.
 * The result may be empty (e.g. a pure error message); callers rely on
 * `trimHistoryForContext` dropping empty messages.
 */
export function stripChatDisplayArtifacts(content: string): string {
  let out = content.replace(/^(?:\[Attached Context: [^\]\n]*\]\n?)+\n*/, '')
  out = out.replace(
    /(?:^|\n+)⚠️ (?:Error(?: during stream)?:|The response was cut off|The response abbreviated|The model answered without|\d+ suggested changes? could not be located)[\s\S]*$/,
    ''
  )
  out = out.replace(/^[📚🔁] [^\n]*\n?/gmu, '')
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
