/**
 * Find-and-replace in a chapter's TEXT, never its markup — the engine of the
 * replace_text tool (agentic_chat_loop.md §0.11, "Fewer steps").
 *
 * Problem: renaming a character across chapters took a read and an edit per
 *   chapter and per occurrence; with ten chapters that was dozens of steps,
 *   and an occurrence missed by the model stayed (user request, 2026-10-12).
 * Fix: one call replaces in the text between tags — never inside a tag, an
 *   attribute or an image's src — literally or by a regular expression, and
 *   reports the count and a few samples. Mirrored byte for byte by
 *   scripts/wc_text/text_replace.py.
 */

export interface TextReplaceOutcome {
  html: string
  count: number
  /** Up to SAMPLE_LIMIT matches in context, "…before[old→new]after…". */
  samples: string[]
  /** Set when nothing could be done: an invalid pattern, or one that matches empty text. */
  error?: string
}

export const SAMPLE_LIMIT = 3
const CONTEXT_CHARS = 12
const TAG_RE = /(<[^>]*>)/

/** Text as it sits in HTML between tags. */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sample(text: string, at: number, length: number, replacement: string): string {
  const before = text.slice(Math.max(0, at - CONTEXT_CHARS), at)
  const after = text.slice(at + length, at + length + CONTEXT_CHARS)
  return `…${before}[${text.slice(at, at + length)}→${replacement}]${after}…`
}

/**
 * A JavaScript replacement template expanded against one match: $$, $&, and
 * $n / $nn (two digits when that group exists). Done by hand, not by
 * re-running the pattern on the match, so both ports expand alike.
 */
export function expandReplacement(template: string, match: string, groups: Array<string | undefined>): string {
  let out = ''
  for (let i = 0; i < template.length; i++) {
    const c = template[i]
    if (c !== '$' || i + 1 >= template.length) { out += c; continue }
    const n = template[i + 1]
    if (n === '$') { out += '$'; i++; continue }
    if (n === '&') { out += match; i++; continue }
    const two = /^\d\d$/.test(template.slice(i + 1, i + 3)) ? Number(template.slice(i + 1, i + 3)) : NaN
    if (two >= 1 && two <= groups.length) { out += groups[two - 1] ?? ''; i += 2; continue }
    const one = /^\d$/.test(n) ? Number(n) : NaN
    if (one >= 1 && one <= groups.length) { out += groups[one - 1] ?? ''; i++; continue }
    out += c
  }
  return out
}

export function replaceInHtmlText(html: string, find: string, replacement: string, regex = false): TextReplaceOutcome {
  if (!find) return { html, count: 0, samples: [], error: 'find was empty' }
  let pattern: RegExp
  if (regex) {
    try {
      pattern = new RegExp(find, 'g')
    } catch {
      // The engines word this differently; the ports must agree, and the model needs only the fact.
      return { html, count: 0, samples: [], error: 'invalid regular expression (check brackets, parentheses and escapes)' }
    }
    if (new RegExp(find).test('')) return { html, count: 0, samples: [], error: 'the pattern matches empty text; it would insert the replacement everywhere' }
  } else {
    pattern = new RegExp(escapeHtmlText(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  }
  const literalReplacement = escapeHtmlText(replacement)
  let count = 0
  const samples: string[] = []
  const parts = html.split(TAG_RE)
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i]
    if (!text) continue
    parts[i] = text.replace(pattern, (...args: unknown[]) => {
      const matched = args[0] as string
      // replace() passes the groups, then the offset (a number), then the string.
      const at = args.findIndex((a, k) => k > 0 && typeof a === 'number')
      const offset = args[at] as number
      const out = regex
        ? expandReplacement(replacement, matched, args.slice(1, at) as Array<string | undefined>)
        : literalReplacement
      count++
      if (samples.length < SAMPLE_LIMIT) samples.push(sample(text, offset, matched.length, out))
      return out
    })
  }
  return { html: parts.join(''), count, samples }
}
