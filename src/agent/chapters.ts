/**
 * How the model names a chapter: by its number in the CHAPTER INDEX, or by
 * its title (spec D2, D6).
 *
 * Numbers are what the index shows first and what a model copies most
 * reliably; titles are what a user says. Both resolve to a document id here,
 * and anything that does not resolve to exactly one chapter comes back as an
 * error the model can read and correct.
 */

export interface NamedChapter {
  id: string
  title: string
}

export interface ResolvedChapter extends NamedChapter {
  /** 1-based position, as the CHAPTER INDEX numbers it. */
  number: number
}

const MAX_LISTED = 12

/** "#3. 第三章" — how results and errors cite a chapter. */
export function citeChapter(c: ResolvedChapter): string {
  return `#${c.number} "${c.title}"`
}

function listChapters(chapters: NamedChapter[]): string {
  const lines = chapters.slice(0, MAX_LISTED).map((c, i) => `${i + 1}. "${c.title}"`)
  if (chapters.length > MAX_LISTED) lines.push(`… ${chapters.length - MAX_LISTED} more (see the CHAPTER INDEX)`)
  return lines.join('\n')
}

/**
 * Resolve a chapter reference against the book, in index order.
 *
 * Accepted: a number (3), a numeric string ("3", "#3"), or a title. A title
 * matches exactly first (trimmed, case-insensitive), then as the only title
 * containing it. Returns an error string otherwise.
 */
export function resolveChapter(ref: unknown, chapters: NamedChapter[]): ResolvedChapter | string {
  const at = (index: number): ResolvedChapter => ({ ...chapters[index], number: index + 1 })

  if (typeof ref === 'number' || (typeof ref === 'string' && /^\s*#?\d+\s*$/.test(ref))) {
    const n = typeof ref === 'number' ? ref : Number(ref.replace(/[#\s]/g, ''))
    if (Number.isInteger(n) && n >= 1 && n <= chapters.length) return at(n - 1)
    return `There is no chapter #${String(ref).trim()}; the book has ${chapters.length} chapters.`
  }

  if (typeof ref !== 'string' || !ref.trim()) {
    return 'No chapter was named. Pass its number from the CHAPTER INDEX or its exact title.'
  }

  const wanted = ref.trim().toLowerCase()
  const exact = chapters.findIndex(c => c.title.trim().toLowerCase() === wanted)
  if (exact !== -1) return at(exact)

  const partial = chapters
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.title.toLowerCase().includes(wanted))
  if (partial.length === 1) return at(partial[0].i)
  if (partial.length > 1) {
    return `"${ref}" matches ${partial.length} chapters — pass a number instead:\n` +
      partial.slice(0, MAX_LISTED).map(({ c, i }) => `${i + 1}. "${c.title}"`).join('\n')
  }
  return `No chapter is titled "${ref}". The chapters are:\n${listChapters(chapters)}`
}
