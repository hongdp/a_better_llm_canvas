/**
 * The conversation past the history window, summarized instead of cut
 * (docs/features/agentic_chat_loop.md §0.9; after Grok Build's compaction).
 *
 * Pure: the plan (what to drop, whether the stored summary still serves),
 * the request to the summarizer, the parse of its reply, and the message
 * pair that carries the summary. The model call is the transport's
 * (useChatLLM for a tab, server_context for a server run). Mirrored by
 * scripts/wc_text/conversation_summary.py — change both together.
 */
import type { LLMMessage } from '../types/llm'
import { IMAGE_PLACEHOLDER_TEXT } from './llmContext'

export interface SummarizableMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
  /**
   * What the message costs in the window when that is not its text: a turn
   * replayed from its transcript (turnTranscripts, cache_continuity.md §3.1).
   */
  weight?: number
}

/** What a transport keeps between turns: the note and the first message kept verbatim after it. */
export interface StoredSummary {
  upToId: string
  text: string
}

export interface SummaryPlan {
  /** Index of the first message sent verbatim; 0 = nothing dropped. */
  cutIndex: number
  /** The note to send: the stored one when it still serves, else null until the call is made. */
  summary: string | null
  /** The summarizer's input when a call is due; null when the stored note serves or nothing is dropped. */
  needs: { previousSummary: string | null; messages: SummarizableMessage[] } | null
  /** The id of the first message kept verbatim (the stored note's key). */
  upToId: string | null
}

/**
 * When a summary is refreshed, the kept tail is this fraction of the
 * budget, not all of it: the next turns then fit without another call.
 */
export const KEEP_FRACTION = 0.4
/** Budget held back for the note itself. */
export const SUMMARY_RESERVE_CHARS = 6_000
/** The summarizer's input cap: the oldest messages past it are dropped with a note. */
export const SUMMARY_INPUT_CHARS = 60_000
/** Each message's cap in the summarizer's input. */
export const SUMMARY_MESSAGE_CHARS = 4_000
/** Messages kept verbatim whatever the budget (trimHistoryForContext's minKeepMessages). */
export const SUMMARY_MIN_KEEP = 2

/** The note's fixed sections: the same for the summarizer and the in-conversation instruction. */
const SUMMARY_FORMAT = `Write the summary inside a single <summary>...</summary> block with exactly these numbered sections, each heading present even when its content is "None":

1. The user's requests and intent: every explicit request, with its constraints, scope and stated preferences, and what the user turned down.
2. Decisions about the book: setting, characters (names, relationships, traits), plot points and their order, the chapter plan, what is established as fact in the story.
3. Voice and style: language, tense, point of view, tone, length targets, and any example the user held up or rejected.
4. What was done: which chapters were written or changed, what each change was, and how each chapter stands now (finished, draft, awaiting the user's review).
5. Problems and how they were resolved, including corrections the user made and why.
6. All user messages, in order, each in one line.
7. Unfinished work and open questions: what the user asked for that is not done, and what is waiting on the user.`

const SUMMARY_RULES = 'Prefer tight prose and short references over verbatim quotes; names, titles and numbers verbatim. Do not call tools, do not add an analysis before the block, and write nothing after the closing tag.'

export const SUMMARY_SYSTEM_PROMPT = `You summarize the earlier part of a conversation between a writer and an assistant that edits the writer's book, so that the assistant can continue after those earlier turns are dropped from its context. The assistant will see the book's current text, this summary and the most recent turns verbatim; what you leave out is lost.

${SUMMARY_FORMAT}

A prior summary, when given, is authoritative for the history it covers: carry its still-relevant content forward. ${SUMMARY_RULES}`

/**
 * The summary asked for at the end of the live conversation
 * (cache_continuity.md §3.4): the same request as the turn, plus this
 * message, so the summarizer reads the conversation from the cache.
 * `keptFrom` is the user's words in the first turn kept verbatim.
 */
export function buildSummaryInstruction(keptFrom: string | null, hasPrior: boolean): string {
  const words = (keptFrom ?? '').replace(/\s+/g, ' ').trim()
  const preview = words.length > 80 ? `${words.slice(0, 80)}…` : words
  const scope = preview
    ? `everything before the turn in which the user wrote "${preview}" will be replaced by a summary; that turn and everything after it stay verbatim`
    : 'the earlier part of it will be replaced by a summary'
  const prior = hasPrior ? ' The summary earlier in this conversation is authoritative for the history it covers: carry its still-relevant content forward.' : ''
  return `STOP — this is not a request to continue the work. This conversation is about to be compacted: ${scope}. Summarize the part being replaced, so that you can continue once it is dropped. You will still see the book's current text, the summary and the turns kept verbatim; what the summary leaves out is lost.${prior}

${SUMMARY_FORMAT}

${SUMMARY_RULES}`
}

const SUMMARY_OPEN = '<conversation_summary>'
const SUMMARY_CLOSE = '</conversation_summary>'

/** The chars a message costs in the window (trimHistoryForContext's accounting). */
function weight(m: SummarizableMessage): number {
  if (m.weight !== undefined) return m.weight
  if (m.content.trim()) return m.content.length
  return m.images && m.images.length > 0 ? IMAGE_PLACEHOLDER_TEXT.length : 0
}

function tailWeight(messages: SummarizableMessage[], from: number): number {
  let sum = 0
  for (let i = from; i < messages.length; i++) sum += weight(messages[i])
  return sum
}

/** The cut that keeps at most `target` chars (and at least SUMMARY_MIN_KEEP messages), starting at a user turn when one is near. */
function cutFor(messages: SummarizableMessage[], target: number): number {
  let kept = 0
  let used = 0
  let cut = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const w = weight(messages[i])
    if (w === 0) { cut = i; continue }
    if (kept >= SUMMARY_MIN_KEEP && used + w > target) break
    used += w
    kept++
    cut = i
  }
  // The window starts with a user turn (providers require it; trimming
  // would drop a leading assistant turn anyway).
  while (cut < messages.length && messages[cut].role !== 'user') cut++
  return cut
}

/**
 * What to do about a history of `budgetChars`: nothing, reuse the stored
 * note, or make a new one. Deterministic; parity-tested.
 */
export function planConversationSummary(messages: SummarizableMessage[], budgetChars: number, stored: StoredSummary | null): SummaryPlan {
  const none: SummaryPlan = { cutIndex: 0, summary: null, needs: null, upToId: null }
  if (tailWeight(messages, 0) <= budgetChars) return none
  const usable = Math.max(0, budgetChars - SUMMARY_RESERVE_CHARS)
  const storedAt = stored ? messages.findIndex(m => m.id === stored.upToId) : -1
  if (stored && storedAt > 0 && tailWeight(messages, storedAt) <= usable) {
    return { cutIndex: storedAt, summary: stored.text, needs: null, upToId: stored.upToId }
  }
  const cut = cutFor(messages, Math.floor(usable * KEEP_FRACTION))
  if (cut <= 0 || cut >= messages.length) return none
  const from = stored && storedAt >= 0 && storedAt <= cut ? storedAt : 0
  return {
    cutIndex: cut,
    summary: null,
    needs: { previousSummary: from > 0 ? (stored as StoredSummary).text : null, messages: messages.slice(from, cut) },
    upToId: messages[cut].id
  }
}

/** The summarizer's request: the prior note, then the transcript as role-tagged data, capped. */
export function buildSummaryRequest(previousSummary: string | null, messages: SummarizableMessage[]): { system: string; user: string; omitted: number } {
  const lines = messages.map(m => {
    const content = m.content.trim() || (m.images && m.images.length > 0 ? IMAGE_PLACEHOLDER_TEXT : '')
    const capped = content.length > SUMMARY_MESSAGE_CHARS ? `${content.slice(0, SUMMARY_MESSAGE_CHARS)}… [truncated]` : content
    return `[${m.role}]\n${capped}`
  })
  let omitted = 0
  let total = lines.reduce((sum, l) => sum + l.length + 2, 0)
  while (lines.length > 1 && total > SUMMARY_INPUT_CHARS) {
    total -= lines[0].length + 2
    lines.shift()
    omitted++
  }
  const prior = previousSummary
    ? `PRIOR SUMMARY (authoritative for the history before this transcript):\n${SUMMARY_OPEN}\n${previousSummary}\n${SUMMARY_CLOSE}\n\n`
    : ''
  const note = omitted > 0 ? `; ${omitted} earlier message${omitted === 1 ? '' : 's'} omitted for length` : ''
  const user = `${prior}TRANSCRIPT (${lines.length} message${lines.length === 1 ? '' : 's'}, oldest first${note}):\n\n${lines.join('\n\n')}\n\nWrite the summary now.`
  return { system: SUMMARY_SYSTEM_PROMPT, user, omitted }
}

/** The note out of the summarizer's reply: the <summary> block's inside, else the whole text; null when empty. */
export function parseSummaryReply(text: string): string | null {
  const m = /<summary>([\s\S]*?)<\/summary>/i.exec(text || '')
  const inner = (m ? m[1] : (text || '').replace(/<\/?summary>/gi, '')).trim()
  return inner ? inner : null
}

/** The pair that carries the note, placed after the ledger and before the kept history. */
export function summaryMessages(summary: string): LLMMessage[] {
  return [
    {
      role: 'user',
      content: `EARLIER IN THIS CONVERSATION (summarized; the messages after this are verbatim):\n${SUMMARY_OPEN}\n${summary}\n${SUMMARY_CLOSE}`,
      cacheHint: true
    },
    { role: 'assistant', content: 'Understood. I will continue from this summary.' }
  ]
}
