/**
 * The review diff a chapter still carries, as the model needs to see it.
 *
 * The model is shown chapters in their ACCEPTED reading (pending markup
 * stripped; see stripDiffMarkup) — the only reading its SEARCH text can be
 * copied from. But that reading hides what the text said BEFORE the pending
 * change, and that is exactly what a user means by "why did you change this?
 * keep what it said before" (user-reported 2026-10-06). Without it the model
 * can only guess the old wording, or rewrite the passage again.
 *
 * So each paragraph with an unresolved change is listed as now/was. Restoring
 * one is an ordinary edit (SEARCH the "now" text, REPLACE with the "was"
 * text): the working copy then matches the confirmed text there, and the
 * review diff — drawn from the last confirmed text (agent docState) — simply
 * has nothing left at that spot, while every other pending change stays.
 */
import { topLevelBlocks, blockText } from './paragraphs'
import { resolveDiffMarkupInHtml } from './diffResolution'

export interface PendingChange {
  /** The paragraph as the user last confirmed it ('' = it did not exist). */
  was: string
  /** As it reads with the change accepted ('' = the change removes it). */
  now: string
}

const MARKUP_RE = /diff-addition|diff-deletion/

export function pendingChanges(html: string): PendingChange[] {
  if (!html || !MARKUP_RE.test(html)) return []
  return topLevelBlocks(html).flatMap(block => {
    if (!MARKUP_RE.test(block)) return []
    const was = blockText(resolveDiffMarkupInHtml(block, 'reject'))
    const now = blockText(resolveDiffMarkupInHtml(block, 'accept'))
    return was === now ? [] : [{ was, now }]
  })
}

/** Per quoted text, and for the whole list: enough for paragraphs, bounded for a rewrite. */
const MAX_TEXT_CHARS = 1500
const MAX_LIST_CHARS = 8000

const quote = (text: string) => {
  if (!text) return '(none)'
  const flat = text.replace(/\n+/g, ' / ')
  return flat.length > MAX_TEXT_CHARS ? `"${flat.slice(0, MAX_TEXT_CHARS)}…" (cut)` : `"${flat}"`
}

/**
 * The list as the model reads it, or '' when nothing is pending — so a
 * chapter without review markup produces exactly the bytes it always did.
 */
export function renderPendingChanges(changes: PendingChange[]): string {
  if (changes.length === 0) return ''
  const lines: string[] = []
  let used = 0
  let listed = 0
  for (const c of changes) {
    const entry = `${listed + 1}. now: ${c.now ? quote(c.now) : '(removed by the change)'}\n   was: ${c.was ? quote(c.was) : '(added by the change)'}`
    if (listed > 0 && used + entry.length > MAX_LIST_CHARS) break
    lines.push(entry)
    used += entry.length
    listed++
  }
  if (listed < changes.length) lines.push(`(${changes.length - listed} more pending change(s) not listed)`)
  return `PENDING CHANGES IN THIS CHAPTER — earlier edits the user has NOT accepted yet. The content above shows them as if accepted; the user can still accept or reject each one.
${lines.join('\n')}
If the user wants part of the earlier version back, change ONLY that part: replace its "now" text with its "was" text, and leave every other pending change as it is.`
}
