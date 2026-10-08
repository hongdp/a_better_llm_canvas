/**
 * What to tell the model when an edit's SEARCH text was not found: the
 * paragraph that comes closest, as exact HTML it can copy, and which class
 * of character kept the two apart.
 *
 * Borrowed from Grok Build's search_replace (2026-10-08): its "not found"
 * answer carries "Nearest match: line N: …" and a hint when the file holds
 * confusable characters (smart quotes, em dashes) that the model typed as
 * their ASCII look-alikes. Measured on this app the same way: a model that
 * is only told "not found — copy it exactly" re-reads the chapter (one more
 * step) or sends the same SEARCH again.
 */
import { chapterParagraphs } from './paragraphs'
import { htmlToComparableText, quoteBlindText } from './text'

export interface NearestParagraph {
  /** 1-based paragraph number, as read_chapter and grep count. */
  number: number
  html: string
  /** Dice similarity over character bigrams of the comparable texts, 0..1. */
  score: number
  /** What differs when the texts match once normalized; empty when they do not. */
  differences: string[]
}

/** Below this the nearest paragraph is not worth showing. */
export const NEAREST_MIN_SCORE = 0.35
/** The hint's HTML is cut here; a long paragraph is better read than quoted whole. */
export const NEAREST_HTML_CAP = 600

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i++) {
    const g = text.slice(i, i + 2)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

/** Dice coefficient over character bigrams: 1 = the same text, 0 = nothing shared. */
export function textSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b && a.length > 0 ? 1 : 0
  const x = bigrams(a)
  const y = bigrams(b)
  let shared = 0
  for (const [g, n] of x) shared += Math.min(n, y.get(g) ?? 0)
  return (2 * shared) / ((a.length - 1) + (b.length - 1))
}

/**
 * The character classes a SEARCH most often gets wrong. Each pair names the
 * two spellings; the hint says which one the chapter uses.
 */
const CONFUSABLE_PAIRS: Array<{ label: string; chapter: RegExp; search: RegExp; chapterName: string; searchName: string }> = [
  { label: 'quotes', chapter: /[“”]/, search: /"/, chapterName: 'curly quotes “ ”', searchName: 'straight quotes "' },
  { label: 'quotes', chapter: /"/, search: /[“”]/, chapterName: 'straight quotes "', searchName: 'curly quotes “ ”' },
  { label: 'apostrophes', chapter: /[‘’]/, search: /'/, chapterName: 'curly apostrophes ‘ ’', searchName: "straight apostrophes '" },
  { label: 'apostrophes', chapter: /&#39;|&apos;/i, search: /'/, chapterName: 'the entity &#39;', searchName: "a literal '" },
  { label: 'spaces', chapter: /&nbsp;/i, search: / /, chapterName: '&nbsp; entities', searchName: 'plain spaces' },
  { label: 'spaces', chapter: /\u00a0/, search: / /, chapterName: 'non-breaking spaces (U+00A0)', searchName: 'plain spaces' },
  { label: 'dashes', chapter: /—/, search: /-|--/, chapterName: 'em dashes —', searchName: 'hyphens' },
  { label: 'dashes', chapter: /–/, search: /-/, chapterName: 'en dashes –', searchName: 'hyphens' },
  { label: 'ellipses', chapter: /…/, search: /\.\.\./, chapterName: 'the ellipsis character …', searchName: 'three dots' },
  { label: 'ampersands', chapter: /&amp;/i, search: /&(?!amp;|lt;|gt;|quot;|nbsp;|#)/, chapterName: '&amp;', searchName: 'a literal &' },
]

/** Which spellings keep `search` from matching `html`, once the texts agree apart from them. */
export function describeDifferences(html: string, search: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const pair of CONFUSABLE_PAIRS) {
    if (seen.has(pair.label)) continue
    if (pair.chapter.test(html) && pair.search.test(search) && !pair.chapter.test(search)) {
      out.push(`the chapter uses ${pair.chapterName} where your SEARCH has ${pair.searchName}`)
      seen.add(pair.label)
    }
  }
  const chapterTags = new Set((html.match(/<(strong|em|b|i|u|s|a|span|code)\b/gi) ?? []).map(t => t.slice(1).toLowerCase()))
  const searchTags = new Set((search.match(/<(strong|em|b|i|u|s|a|span|code)\b/gi) ?? []).map(t => t.slice(1).toLowerCase()))
  const missing = [...chapterTags].filter(t => !searchTags.has(t))
  if (missing.length > 0) out.push(`the chapter has inline <${missing.join('>, <')}> tags your SEARCH leaves out`)
  if (/<(?:p|h[1-6]|li|blockquote)\b[^>]*\s[a-z-]+=/i.test(html) && !/<[a-z0-9]+\s[a-z-]+=/i.test(search)) {
    out.push('the chapter\'s tag carries attributes your SEARCH leaves out')
  }
  return out
}

/**
 * The paragraph of `html` closest to the first block of `search`, or null
 * when nothing comes close enough to be worth quoting.
 */
export function nearestParagraph(html: string, search: string): NearestParagraph | null {
  const firstBlock = search.split(/<\/(?:p|h[1-6]|li|blockquote)>/i)[0] ?? search
  const wanted = quoteBlindText(firstBlock)
  if (!wanted) return null
  let best: NearestParagraph | null = null
  for (const para of chapterParagraphs(html)) {
    if (para.kind === 'image') continue
    const score = textSimilarity(wanted, quoteBlindText(para.html))
    if (score > (best?.score ?? -1)) best = { number: para.number, html: para.html, score, differences: [] }
  }
  if (!best || best.score < NEAREST_MIN_SCORE) return null
  const normalizedMatch = htmlToComparableText(best.html) === htmlToComparableText(firstBlock) || quoteBlindText(best.html) === wanted
  best.differences = normalizedMatch || best.score >= 0.9 ? describeDifferences(best.html, firstBlock) : []
  return best
}

/** One line per failed SEARCH, with its nearest paragraph, for the tool result. */
export function nearestHint(html: string, search: string): string {
  const near = nearestParagraph(html, search)
  if (!near) return ''
  const shown = near.html.length > NEAREST_HTML_CAP ? `${near.html.slice(0, NEAREST_HTML_CAP)}…` : near.html
  const why = near.differences.length > 0 ? ` It differs only in spelling: ${near.differences.join('; ')}.` : ''
  return `  Nearest: ¶${near.number} — copy this HTML exactly: ${shown}${why}`
}
