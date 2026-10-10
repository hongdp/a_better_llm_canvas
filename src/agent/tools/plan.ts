/**
 * `plan`: the model's checklist for a turn of several steps (several
 * chapters), shown live under its bubble. The loop reminds the model of it
 * after each step and asks it to finish or drop what is left before a reply
 * with no action ends the turn (agent/reminders, run.ts).
 *
 * Modeled on Grok Build's todo_write (2026-10-08): a short description, a
 * list with statuses, a status-only call merging into the list.
 */
import { defineTool } from '../registry'
import { writesSoFar, type ToolContext, type ToolResult } from '../types'
import { applyPlanUpdate, renderPlan, type PlanItem } from '../../utils/plan'
import { isBlankContent } from '../../utils/text'
import { planNotWrittenNote } from '../reminders'

const titleKey = (title: string) => title.replace(/\s+/g, '').toLowerCase()
/** An item whose title says it changes the book, in either language. */
const WRITE_ITEM_RE = /写|改|补|删|增|润色|rewrite|write|edit|revise|insert|add|create|polish|delete|rename|expand|fix/i

/** `plan_done` as a write's argument: ids as a list, or one comma-separated string. */
export function planDoneArg(raw: Record<string, unknown> | null): string[] {
  const value = raw?.plan_done
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\s]+/) : []
  return [...new Set(list.map(v => String(v).trim()).filter(Boolean))]
}

/**
 * Mark plan items done because the write that finished them landed
 * (agentic_chat_loop.md §0.11): the bookkeeping rides on the write instead of
 * taking a step of its own. The next pending item becomes in progress when
 * none is. Returns the plan as the result shows it, or '' with nothing to do.
 */
export function markPlanDone(ctx: ToolContext, ids: string[]): string {
  if (ids.length === 0) return ''
  if (ctx.run.plan.length === 0) return 'plan_done was ignored: there is no plan.'
  const unknown = ids.filter(id => !ctx.run.plan.some(i => i.id === id))
  let plan: PlanItem[] = ctx.run.plan.map(i => ids.includes(i.id) ? { ...i, status: 'done' as const } : i)
  if (!plan.some(i => i.status === 'in_progress')) {
    const next = plan.find(i => i.status === 'pending')
    if (next) {
      plan = plan.map(i => i.id === next.id ? { ...i, status: 'in_progress' as const } : i)
      ctx.run.planBaseline.set(next.id, writesSoFar(ctx.run))
    }
  }
  ctx.run.plan = plan
  return renderPlan(plan) + (unknown.length > 0 ? `\n(plan_done: ${unknown.map(u => `"${u}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the plan.)` : '')
}

/** A write's result with its plan_done applied — only when the write landed. */
export function withPlanDone(ctx: ToolContext, result: ToolResult, ids: string[]): ToolResult {
  if (!result.ok || ids.length === 0) return result
  const note = markPlanDone(ctx, ids)
  if (!note) return result
  const done = ctx.run.plan.filter(i => i.status === 'done' || i.status === 'dropped').length
  return { ...result, content: `${result.content}\n\n${note}`, trace: `${result.trace} · 📋 plan ${done}/${ctx.run.plan.length}` }
}

/** The plan_done property every write tool's schema gets. */
export const PLAN_DONE_PARAMETER = {
  type: 'array',
  description: 'Optional: ids of plan items this write completes. They are marked done once it lands, with no separate plan call.',
  items: { type: 'string' }
} as const

export const planTool = defineTool<{ items: unknown; merge: boolean | undefined }>({
  name: 'plan',
  description:
    'Keep a checklist of the steps of this turn. The user sees it live under your reply; the editor reminds you of it after each step. ' +
    'Use it when the request takes 3 or more steps (several chapters to write, a series of edits); skip it for one-step work. ' +
    'Send the whole list to create or reorder it; to update statuses, send only {id, status} for the items that changed. Keep one item in_progress at a time and mark each done as soon as it is.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'The steps, in order.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A short stable id (e.g. "ch5"). Required for a status update; optional when sending the whole list.' },
            title: { type: 'string', description: 'The step, e.g. "Write chapter 5: the harbor".' },
            status: { type: 'string', description: '"pending" (default), "in_progress", "done" or "dropped".' }
          }
        }
      },
      merge: { type: 'boolean', description: 'true: update only the items named, keep the rest. Default false (replace the list).' }
    },
    required: ['items']
  },
  kind: 'read',
  isAvailable: () => true,
  parse: raw => (raw ? { items: raw.items, merge: typeof raw.merge === 'boolean' ? raw.merge : undefined } : 'its arguments could not be parsed'),
  execute: ({ items, merge }, ctx): ToolResult => {
    const applied = applyPlanUpdate(ctx.run.plan, items, merge)
    if (typeof applied === 'string') return { ok: false, retryable: true, content: `plan was not updated: ${applied}`, trace: `⚠️ plan: ${applied}` }
    // A write item is done only once something was written since it started
    // (2026-10-08: "改写第十四章" was marked done in the reply meant to write
    // it; the write came one step later). The item keeps its state and the
    // result says why.
    const written = writesSoFar(ctx.run)
    const before = new Map(ctx.run.plan.map(i => [i.id, i]))
    const refused: string[] = []
    const updated = applied.map(item => {
      const prev = before.get(item.id)
      if (!prev || item.status === 'in_progress') ctx.run.planBaseline.set(item.id, prev?.status === 'in_progress' && item.status === 'in_progress' ? (ctx.run.planBaseline.get(item.id) ?? written) : written)
      if (item.status === 'done' && prev && prev.status !== 'done' && WRITE_ITEM_RE.test(item.title) && written <= (ctx.run.planBaseline.get(item.id) ?? written)) {
        refused.push(planNotWrittenNote(item.title))
        return { ...item, status: prev.status === 'pending' ? 'in_progress' as const : prev.status }
      }
      return item
    })
    for (const id of [...ctx.run.planBaseline.keys()]) if (!updated.some(i => i.id === id)) ctx.run.planBaseline.delete(id)
    ctx.run.plan = updated
    // A step marked done that names a chapter which does not exist, or is
    // empty, was not done in the book — say so before the model builds on it.
    const chapters = ctx.document.chapters()
    const notes = updated
      .filter(i => i.status === 'done')
      .flatMap(i => {
        const named = chapters.find(c => i.title.toLowerCase().includes(titleKey(c.title)) || titleKey(i.title).includes(titleKey(c.title)))
        if (!named) return []
        return named.loaded !== false && isBlankContent(named.content) ? [`"${i.title}" is marked done, but the chapter "${named.title}" is still empty.`] : []
      })
    const done = updated.filter((i: PlanItem) => i.status === 'done' || i.status === 'dropped').length
    return {
      ok: true,
      content: renderPlan(updated) + ([...refused, ...notes].length > 0 ? `\n${[...refused, ...notes].join('\n')}` : ''),
      trace: `📋 plan ${done}/${updated.length}${refused.length > 0 ? ' (a "done" refused: nothing written yet)' : ''}`
    }
  }
})
