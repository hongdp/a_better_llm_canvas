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
import type { ToolResult } from '../types'
import { applyPlanUpdate, renderPlan, type PlanItem } from '../../utils/plan'
import { isBlankContent } from '../../utils/text'

const titleKey = (title: string) => title.replace(/\s+/g, '').toLowerCase()

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
    const updated = applyPlanUpdate(ctx.run.plan, items, merge)
    if (typeof updated === 'string') return { ok: false, retryable: true, content: `plan was not updated: ${updated}`, trace: `⚠️ plan: ${updated}` }
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
      content: renderPlan(updated) + (notes.length > 0 ? `\n${notes.join('\n')}` : ''),
      trace: `📋 plan ${done}/${updated.length}`
    }
  }
})
