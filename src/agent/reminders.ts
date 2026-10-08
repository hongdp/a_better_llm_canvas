/**
 * What the loop tells the model between steps, besides the tool results:
 * automated context, in `<system-reminder>` blocks appended to the last
 * result message (never a message of their own — providers that insist on
 * alternating roles, and the cached prefix, both stay intact).
 *
 * The device and most of the texts follow Grok Build (2026-10-08): its
 * harness appends reminders to tool results and tells the model they are
 * automated context; its loop nudges a model that repeats the same call
 * before it stops it, and tells a model whose last step reasoned at length
 * to act instead. Pure: texts and the append.
 */
import type { LLMMessage } from '../types/llm'
import type { PlanItem } from '../utils/plan'
import { renderPlan, unfinishedPlanItems } from '../utils/plan'

export const REMINDER_TAG = 'system-reminder'

export function wrapReminder(text: string): string {
  return `<${REMINDER_TAG}>\n${text}\n</${REMINDER_TAG}>`
}

/** Reminders ride on the last message of a step's results. */
export function appendReminders(messages: LLMMessage[], reminders: string[]): LLMMessage[] {
  if (reminders.length === 0 || messages.length === 0) return messages
  const last = messages[messages.length - 1]
  const block = reminders.map(wrapReminder).join('\n')
  return [...messages.slice(0, -1), { ...last, content: last.content ? `${last.content}\n\n${block}` : block }]
}

/** Identical steps before the model is told it repeats itself. */
export const REPEAT_NUDGE_STEPS = 3
/** Identical steps before a server run is paused for the user (a tab-run only nudges). */
export const REPEAT_PAUSE_STEPS = 6

export function repeatNudge(calls: string[], runLen: number): string {
  const what = calls.length === 1 ? `the same call (${calls[0]})` : `the same calls (${calls.join(', ')})`
  return `You have made ${what} with the same arguments ${runLen} times in a row, and nothing was written in between. The answer will not change by asking again. ` +
    'Do something else with what you already have: write the chapter, or read a different part of the book. ' +
    'If you cannot make progress, stop and tell the user what you are missing. ' +
    (runLen >= REPEAT_PAUSE_STEPS - REPEAT_NUDGE_STEPS + 1 ? '' : `This run is paused for the user if the identical calls reach ${REPEAT_PAUSE_STEPS}.`)
}

/** Hidden reasoning tokens in one step, past which the next step is told to act (0 = off). */
export const DEFAULT_LONG_REASONING_TOKENS = 0

export function longReasoningReminder(tokens: number): string {
  return `Your previous step used a very long hidden reasoning trace (about ${tokens.toLocaleString()} tokens) and wrote nothing. ` +
    'From here on, do not reason at length between tool results: read the result, decide the single next action, and emit it, with a few sentences of reasoning at most. ' +
    'Verify by reading or searching the book, never by thinking at length. Plan a chapter in the reply that writes it.'
}

/** The plan after a step, for the model: progress and what comes next. */
export function planReminder(plan: PlanItem[]): string {
  return renderPlan(plan)
}

/** A reply with no action while the plan has work left. */
export function planUnfinishedNudge(plan: PlanItem[]): string {
  const left = unfinishedPlanItems(plan)
  return `Your plan still has ${left.length} unfinished item${left.length === 1 ? '' : 's'}:\n${left.map(i => `- ${i.title}`).join('\n')}\n` +
    'Continue with the next one in your next reply. If an item no longer applies, mark it dropped with the plan tool and say why; a reply with no action ends the turn only once every item is done or dropped.'
}

export const PLAN_NUDGE_BUDGET = 2

/**
 * A plan item marked done while nothing was written since it started
 * (2026-10-08: grok marked "改写第十四章" done in the reply that was meant
 * to write it, and wrote it one step later).
 */
export function planNotWrittenNote(title: string): string {
  return `"${title}" was marked done, but nothing has been written to the book since it started. It stays in_progress: do the write in this reply, then mark it done.`
}

/** The reply that ends a turn after an HTML read that no edit followed (the same run: ¶88 read, never edited). */
export function htmlReadNudge(trace: string): string {
  return `Your last read of a chapter's HTML (${trace}) is the step before an edit, and no change followed it. Make the edit now, or say in your reply why it is not needed.`
}

export function userEditedReminder(chapters: Array<{ number: number; title: string }>): string {
  const names = chapters.map(c => `#${c.number} "${c.title}"`).join(', ')
  return `The user changed ${names} while you were working. What you read of ${chapters.length === 1 ? 'it' : 'them'} is out of date: read ${chapters.length === 1 ? 'it' : 'them'} again before relying on ${chapters.length === 1 ? 'it' : 'them'} or writing to ${chapters.length === 1 ? 'it' : 'them'}, and keep the user's edits.`
}

export function structureChangedReminder(outline: string): string {
  return `The user changed the book's chapter list while you were working. It is now:\n${outline}\nChapter numbers in your earlier replies may be off; use these.`
}

export function queuedRequestReminder(count: number): string {
  return `The user has sent ${count === 1 ? 'another request that is' : `${count} more requests that are`} waiting for this turn to finish. Finish the work of this turn; do not start anything beyond it.`
}

export const REMINDERS_ARE_CONTEXT = '<system-reminder> blocks inside tool results are automated context from the editor, not messages from the user.'
