/**
 * The run's plan: a checklist the model keeps for work of several steps
 * (several chapters), shown live under its bubble and used by the loop to
 * say what comes next and to notice an early ending.
 *
 * The shape follows Grok Build's todo_write (2026-10-08): items with a
 * status, a whole-list replace by default, a merge when the call only
 * updates statuses of items that exist. Pure: no loop state here.
 */
export type PlanStatus = 'pending' | 'in_progress' | 'done' | 'dropped'

export interface PlanItem {
  id: string
  title: string
  status: PlanStatus
}

const STATUSES: PlanStatus[] = ['pending', 'in_progress', 'done', 'dropped']

/** One raw item from the model, validated; null when it names nothing. */
function parseItem(raw: unknown, index: number): PlanItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : typeof r.content === 'string' ? r.content.trim() : ''
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : typeof r.id === 'number' ? String(r.id) : title ? `p${index + 1}` : ''
  if (!id) return null
  const status = typeof r.status === 'string' && (STATUSES as string[]).includes(r.status) ? (r.status as PlanStatus)
    : r.status === 'completed' ? 'done' : r.status === 'cancelled' ? 'dropped' : 'pending'
  return { id, title, status }
}

/**
 * Apply the model's call to the current plan. A call whose every item names
 * an existing id and carries no title is a status update (merge), as is one
 * that says `merge: true`; anything else replaces the list.
 */
export function applyPlanUpdate(current: PlanItem[], rawItems: unknown, merge: boolean | undefined): PlanItem[] | string {
  const list = Array.isArray(rawItems) ? rawItems : []
  const items = list.map((raw, i) => parseItem(raw, i)).filter((i): i is PlanItem => i !== null)
  if (items.length === 0) return 'no items were given (each needs a title; a status update needs an id)'
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) return `duplicate item id "${item.id}"`
    ids.add(item.id)
  }
  const byId = new Map(current.map(i => [i.id, i]))
  const statusOnly = current.length > 0 && items.every(i => byId.has(i.id) && !i.title)
  if (merge || statusOnly) {
    for (const item of items) {
      if (!byId.has(item.id)) return `item "${item.id}" is not in the plan; send the whole list to add items`
    }
    return current.map(i => {
      const update = items.find(u => u.id === i.id)
      return update ? { ...i, status: update.status, ...(update.title ? { title: update.title } : {}) } : i
    })
  }
  if (items.some(i => !i.title)) return 'an item has no title'
  return items
}

const MARK: Record<PlanStatus, string> = { pending: '☐', in_progress: '▶', done: '☑', dropped: '✕' }

/** The plan as the model and the bubble see it. */
export function renderPlan(items: PlanItem[]): string {
  const done = items.filter(i => i.status === 'done' || i.status === 'dropped').length
  const lines = items.map(i => `${MARK[i.status]} ${i.title}`)
  const next = nextPlanItem(items)
  return `PLAN (${done}/${items.length} done):\n${lines.join('\n')}${next ? `\nNext: ${next.title}` : '\nAll items are done.'}`
}

/** The item being worked on, else the first pending one. */
export function nextPlanItem(items: PlanItem[]): PlanItem | null {
  return items.find(i => i.status === 'in_progress') ?? items.find(i => i.status === 'pending') ?? null
}

export function unfinishedPlanItems(items: PlanItem[]): PlanItem[] {
  return items.filter(i => i.status === 'pending' || i.status === 'in_progress')
}
