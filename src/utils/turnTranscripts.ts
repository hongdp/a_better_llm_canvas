/**
 * Earlier turns replayed as they were sent (docs/features/cache_continuity.md
 * §3.1). A finished turn's transcript — its final user message as sent, every
 * step's messages, the reply that ended it — replaces the collapsed
 * user/assistant pair in the next turn's history, so the next request
 * extends the previous one byte for byte and the provider's prefix cache
 * holds across turns.
 *
 * Pure. Mirrored by scripts/wc_text/turn_transcripts.py — change both together.
 */
import type { LLMMessage } from '../types/llm'
import type { SummarizableMessage } from './conversationSummary'
import { trimHistoryForContext } from './llmContext'

/** A finished turn as sent, stored under its reply's message id. */
export interface TurnTranscript {
  /** The chat message the turn answered; the transcript is used only right after it. */
  userMessageId: string | null
  messages: LLMMessage[]
}

/** A history message as the window would send it collapsed (display artifacts stripped, trace noted). */
export type HistoryEntry = LLMMessage & { id: string }

/** One piece of the history: a single collapsed message, or a turn replayed from its transcript. */
export interface HistoryUnit {
  /** Index of the unit's first entry. */
  start: number
  /** Entries it covers: 1, or 2 (user + reply) for a transcript. */
  count: number
  /** The reply's message id when the unit is a transcript, else null. */
  turn: string | null
}

/** Which entries are replayed from a transcript: a user message followed by the reply whose transcript names it. */
export function planHistoryUnits(entries: Array<{ id: string; role: string }>, transcripts: Record<string, TurnTranscript>): HistoryUnit[] {
  const units: HistoryUnit[] = []
  for (let i = 0; i < entries.length; i++) {
    const next = entries[i + 1]
    const t = next ? transcripts[next.id] : undefined
    if (entries[i].role === 'user' && next?.role === 'assistant' && t && t.userMessageId === entries[i].id && t.messages.length > 0) {
      units.push({ start: i, count: 2, turn: next.id })
      i++
      continue
    }
    units.push({ start: i, count: 1, turn: null })
  }
  return units
}

/** The chars a transcript costs: every message's text and its tool calls' argument bytes. */
export function transcriptWeight(messages: LLMMessage[]): number {
  let sum = 0
  for (const m of messages) {
    sum += m.content.length
    for (const call of m.toolCalls ?? []) sum += call.argumentsText.length
  }
  return sum
}

/**
 * The history as the summary planner counts it: a replayed turn weighs what
 * its transcript sends (its reply's share on the reply, the rest on the user
 * message), so the budget stays honest about a turn's tool results.
 */
export function summarizableHistory(entries: HistoryEntry[], units: HistoryUnit[], transcripts: Record<string, TurnTranscript>): SummarizableMessage[] {
  const out: SummarizableMessage[] = entries.map(m => ({
    id: m.id, role: m.role as 'user' | 'assistant', content: m.content, ...(m.images ? { images: m.images } : {})
  }))
  for (const u of units) {
    if (u.turn === null) continue
    const messages = transcripts[u.turn].messages
    const total = transcriptWeight(messages)
    const last = messages[messages.length - 1]
    const reply = last.role === 'assistant' ? Math.min(total, last.content.length) : 0
    out[u.start] = { ...out[u.start], weight: Math.max(1, total - reply) }
    out[u.start + 1] = { ...out[u.start + 1], weight: reply }
  }
  return out
}

function unitWeight(entries: HistoryEntry[], u: HistoryUnit, transcripts: Record<string, TurnTranscript>): number {
  if (u.turn !== null) return transcriptWeight(transcripts[u.turn].messages)
  return entries[u.start].content.length
}

function withoutId(m: HistoryEntry): LLMMessage {
  const copy: LLMMessage & { id?: string } = { ...m }
  delete copy.id
  return copy
}

/**
 * The history messages from entry `from` on, within `maxChars` (null = no
 * cap). A replayed turn's messages go out as stored (copies, no cache hint);
 * the collapsed messages between them are normalized as
 * trimHistoryForContext does. A cap drops whole units from the front. With
 * no transcript in the window this is exactly trimHistoryForContext.
 * `present` lists the turns replayed — what the tail's "unchanged" lines may
 * point back to (cache_continuity.md §3.2).
 */
export function historyWindow(
  entries: HistoryEntry[],
  units: HistoryUnit[],
  transcripts: Record<string, TurnTranscript>,
  from: number,
  maxChars: number | null
): { messages: LLMMessage[]; present: string[] } {
  let kept = units.filter(u => u.start >= from)
  if (!kept.some(u => u.turn !== null)) {
    return {
      messages: trimHistoryForContext(entries.slice(from).map(withoutId), { maxChars: maxChars ?? Number.MAX_SAFE_INTEGER }),
      present: []
    }
  }
  if (maxChars !== null) {
    // At least two messages, as trimHistoryForContext keeps: a reply alone would be dropped.
    let used = 0
    let count = 0
    let first = kept.length
    for (let i = kept.length - 1; i >= 0; i--) {
      const w = unitWeight(entries, kept[i], transcripts)
      if (count >= 2 && used + w > maxChars) break
      used += w
      count += kept[i].count
      first = i
    }
    kept = kept.slice(first)
  }
  const messages: LLMMessage[] = []
  const present: string[] = []
  let pending: LLMMessage[] = []
  const flush = () => {
    if (pending.length > 0) messages.push(...trimHistoryForContext(pending, { maxChars: Number.MAX_SAFE_INTEGER, minKeepMessages: pending.length }))
    pending = []
  }
  for (const u of kept) {
    if (u.turn === null) {
      pending.push(withoutId(entries[u.start]))
      continue
    }
    flush()
    present.push(u.turn)
    for (const m of transcripts[u.turn].messages) {
      const copy = { ...m }
      delete copy.cacheHint
      messages.push(copy)
    }
  }
  flush()
  // The window starts with a user turn.
  while (messages.length > 0 && messages[0].role === 'assistant') messages.shift()
  return { messages, present }
}
