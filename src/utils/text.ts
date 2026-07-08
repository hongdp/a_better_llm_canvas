/**
 * Text utility functions.
 * Pure helpers for text processing — no React dependencies.
 */

/**
 * Generate a timestamp-based unique ID with the given prefix.
 */
export function getTimestampId(prefix: string): string {
  return `${prefix}-${Date.now()}`
}

/**
 * Strip an incomplete `</selection_replace>` suffix from streamed LLM text.
 * This handles the case where the stream is interrupted mid-tag.
 */
export function stripIncompleteEndTag(text: string): string {
  const target = '</selection_replace>'
  for (let i = target.length; i > 0; i--) {
    const prefix = target.substring(0, i)
    if (text.endsWith(prefix)) {
      return text.substring(0, text.length - prefix.length)
    }
  }
  return text
}

/**
 * Result of extracting an XML-like tagged block (e.g. `<canvas>...</canvas>`)
 * from a raw LLM response.
 */
export interface TaggedBlock {
  /** An opening tag was found. */
  found: boolean
  /** A matching closing tag was found (false ⇒ the stream was likely truncated). */
  closed: boolean
  /** Content between the tags (partial if `closed` is false). */
  inner: string
  /** Text before the opening tag. */
  before: string
  /** Text after the closing tag (empty if `closed` is false). */
  after: string
}

/**
 * Robustly extract the first `<tag>...</tag>` block from an LLM response.
 *
 * Unlike a plain `indexOf('<tag>')`, this tolerates the real-world variations
 * models emit: case differences (`<Canvas>`), attributes (`<canvas foo="bar">`),
 * and whitespace in the closing tag (`</canvas >`). It also surrounds an
 * optional ```html / ``` markdown code fence so a fenced block still parses.
 *
 * Crucially it reports whether the closing tag was actually seen, so callers
 * can refuse to apply a destructive document replacement built from a
 * truncated (cut-off) response.
 */
export function extractTaggedBlock(text: string, tag: string): TaggedBlock {
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'i')
  const openMatch = openRe.exec(text)
  if (!openMatch) {
    return { found: false, closed: false, inner: '', before: text, after: '' }
  }

  const before = text.substring(0, openMatch.index)
  const rest = text.substring(openMatch.index + openMatch[0].length)

  const closeRe = new RegExp(`</${tag}\\s*>`, 'i')
  const closeMatch = closeRe.exec(rest)
  if (!closeMatch) {
    return { found: true, closed: false, inner: rest, before, after: '' }
  }

  const inner = rest.substring(0, closeMatch.index)
  const after = rest.substring(closeMatch.index + closeMatch[0].length)

  // Strip a wrapping markdown code fence around the inner HTML, if present.
  const fenced = inner.match(/^\s*```(?:html)?\s*([\s\S]*?)\s*```\s*$/i)
  return {
    found: true,
    closed: true,
    inner: fenced ? fenced[1] : inner,
    before,
    after
  }
}

/**
 * Detect explicit "elision" / lazy-omission markers in an LLM-produced document
 * replacement. When asked to re-emit a long document, models often abbreviate
 * unchanged regions with placeholders like `<!-- rest unchanged -->` or
 * `[content continues]`. Diffing the original against such output silently
 * deletes everything that was elided, so callers should refuse to apply it.
 *
 * Only flags EXPLICIT omission language (keywords inside comments / brackets /
 * parentheses) or a whole-paragraph ellipsis — never a bare "..." inside prose,
 * which is legitimate in fiction.
 */
export function hasElisionMarkers(html: string): boolean {
  const keyword = '(?:unchanged|omitted|omit|continues?|rest of (?:the |your )?(?:document|text|content|chapter)|remains? (?:the )?same|same as (?:before|above|previous)|as before|truncat\\w*|abbreviat\\w*|previous content|earlier content)'

  // 1. HTML comment containing omission language: <!-- ... rest unchanged -->
  if (new RegExp(`<!--[\\s\\S]*?${keyword}[\\s\\S]*?-->`, 'i').test(html)) {
    return true
  }
  // 2. Bracketed placeholder: [content continues], [unchanged], [...]
  if (new RegExp(`\\[[^\\]]{0,60}?${keyword}[^\\]]{0,40}?\\]`, 'i').test(html)) {
    return true
  }
  // 3. Parenthetical placeholder: (rest of the document remains the same)
  if (new RegExp(`\\([^)]{0,60}?${keyword}[^)]{0,40}?\\)`, 'i').test(html)) {
    return true
  }
  // 4. A paragraph whose entire content is just an ellipsis.
  if (/<p>\s*(?:\.\.\.|…)\s*<\/p>/i.test(html)) {
    return true
  }
  return false
}

/**
 * Validate a full-document (`<canvas>`) replacement before applying it as a diff.
 *
 * Returns a machine-readable reason string when the replacement looks unsafe to
 * apply (and would likely destroy content), or `null` when it is safe.
 *
 * - `'truncated'` — the closing tag never arrived; the response was cut off.
 * - `'elided'`    — the output abbreviates unchanged regions with placeholders.
 */
export function validateCanvasReplacement(
  newHtml: string,
  closingTagFound: boolean
): 'truncated' | 'elided' | null {
  if (!closingTagFound) return 'truncated'
  if (hasElisionMarkers(newHtml)) return 'elided'
  return null
}

/** A single localized search/replace edit emitted by the LLM. */
export interface EditBlock {
  /** Exact text from the current document to locate. */
  search: string
  /** Text to substitute in its place (may be empty for a deletion). */
  replace: string
}

/** Result of parsing `<edit>` / conflict-marker blocks from an LLM response. */
export interface ParsedEdits {
  blocks: EditBlock[]
  /** Chat text before the edit region. */
  before: string
  /** Chat text after the edit region. */
  after: string
}

// Matches one Aider-style conflict block:
//   <<<<<<< SEARCH
//   ...search...
//   =======
//   ...replace...
//   >>>>>>> REPLACE
// Marker lengths and trailing label whitespace are tolerated.
const EDIT_BLOCK_RE = /<{5,}\s*SEARCH[^\n]*\n([\s\S]*?)\n={3,}[^\n]*\n([\s\S]*?)\n>{5,}\s*REPLACE/gi

/**
 * Parse localized edit blocks from an LLM response.
 *
 * This is the parser for Method A (search/replace edits): rather than re-emit
 * the whole document, the model emits only the changed regions as
 * SEARCH/REPLACE pairs. Parsing is lenient — the conflict markers are matched
 * globally whether or not they are wrapped in `<edit>` tags, and the surrounding
 * `<edit>`/`<edits>` sugar is stripped from the returned chat text.
 */
export function parseEditBlocks(text: string): ParsedEdits {
  const blocks: EditBlock[] = []
  let firstStart = -1
  let lastEnd = -1

  EDIT_BLOCK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EDIT_BLOCK_RE.exec(text)) !== null) {
    if (m[1].trim()) {
      blocks.push({ search: m[1], replace: m[2] })
    }
    if (firstStart === -1) firstStart = m.index
    lastEnd = EDIT_BLOCK_RE.lastIndex
  }

  if (blocks.length === 0) {
    return { blocks, before: '', after: '' }
  }

  const stripSugar = (s: string) => s.replace(/<\/?edits?\s*>/gi, '').trim()
  return {
    blocks,
    before: stripSugar(text.slice(0, firstStart)),
    after: stripSugar(text.slice(lastEnd))
  }
}

/** Result of applying a list of edit blocks to a document. */
export interface ApplyEditsResult {
  /** The document after all matched edits were applied. */
  html: string
  /** Edits whose SEARCH text could not be located (left unapplied). */
  failed: EditBlock[]
}

/**
 * Build a regex pattern from `search` where characters the LLM commonly
 * normalizes are matched as equivalence classes instead of literally:
 * whitespace runs ⇔ `&nbsp;`, straight ⇔ curly quotes, `&` ⇔ `&amp;`.
 * Everything else is escaped and matched exactly (tags included).
 */
function buildFuzzyPattern(search: string): string {
  let out = ''
  let i = 0
  const isWs = (idx: number) => /\s/.test(search[idx]) || search.startsWith('&nbsp;', idx)
  while (i < search.length) {
    if (isWs(i)) {
      out += '(?:\\s|&nbsp;)+'
      while (i < search.length && isWs(i)) i += search.startsWith('&nbsp;', i) ? 6 : 1
      continue
    }
    const ch = search[i]
    if (ch === "'" || ch === '‘' || ch === '’' || search.startsWith('&#39;', i) || search.startsWith('&apos;', i)) {
      out += "(?:'|‘|’|&#39;|&apos;)"
      i += search.startsWith('&#39;', i) ? 5 : search.startsWith('&apos;', i) ? 6 : 1
      continue
    }
    if (ch === '"' || ch === '“' || ch === '”' || search.startsWith('&quot;', i)) {
      out += '(?:"|“|”|&quot;)'
      i += search.startsWith('&quot;', i) ? 6 : 1
      continue
    }
    if (ch === '&') {
      out += '(?:&amp;|&)'
      i += search.startsWith('&amp;', i) ? 5 : 1
      continue
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i++
  }
  return out
}

/**
 * Reduce an HTML fragment to comparable plain text: tags stripped, common
 * entities decoded, quotes straightened, whitespace collapsed. Used for the
 * last-resort block-level text match.
 */
function htmlToComparableText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;|[‘’]/gi, "'")
    .replace(/&quot;|[“”]/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// Closing tags that terminate a top-level block, for the block-text fallback.
const EDIT_BLOCK_SPLIT_RE = /<\/(?:p|h[1-6]|blockquote|pre|ul|ol|table|figure|div)>/gi

/**
 * Last-resort match: if the SEARCH's *plain text* equals the plain text of a
 * contiguous run of whole blocks (paragraphs/headings/lists), replace those
 * whole blocks. This survives the model dropping or altering inline tags
 * (<strong>, <em>, attributes) in its SEARCH copy, and can never produce
 * unbalanced HTML because only complete blocks are swapped.
 */
function replaceByBlockText(haystack: string, search: string, replace: string): string | null {
  const searchText = htmlToComparableText(search)
  if (!searchText) return null

  // Split the haystack into block segments, each ending at a closing block tag.
  const segments: { start: number; end: number; text: string }[] = []
  EDIT_BLOCK_SPLIT_RE.lastIndex = 0
  let segStart = 0
  let m: RegExpExecArray | null
  while ((m = EDIT_BLOCK_SPLIT_RE.exec(haystack)) !== null) {
    const end = m.index + m[0].length
    segments.push({ start: segStart, end, text: htmlToComparableText(haystack.slice(segStart, end)) })
    segStart = end
  }
  if (segStart < haystack.length) {
    segments.push({ start: segStart, end: haystack.length, text: htmlToComparableText(haystack.slice(segStart)) })
  }

  // Find a contiguous run of blocks whose concatenated text equals searchText.
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i].text) continue
    let acc = ''
    for (let j = i; j < segments.length; j++) {
      if (segments[j].text) acc = acc ? acc + ' ' + segments[j].text : segments[j].text
      if (acc === searchText) {
        return haystack.slice(0, segments[i].start) + replace + haystack.slice(segments[j].end)
      }
      if (acc.length > searchText.length) break
    }
  }
  return null
}

/**
 * Locate `search` in `haystack` and return the string with it replaced by
 * `replace`, or `null` if it cannot be found. Tries progressively fuzzier
 * matches so a model that doesn't reproduce the document byte-for-byte still
 * applies: exact ⇒ trimmed ⇒ whitespace-insensitive ⇒ entity/quote-insensitive
 * ⇒ whole-block plain-text match.
 */
function applyOneEdit(haystack: string, search: string, replace: string): string | null {
  // 1. Exact substring.
  const exactIdx = haystack.indexOf(search)
  if (exactIdx !== -1) {
    return haystack.slice(0, exactIdx) + replace + haystack.slice(exactIdx + search.length)
  }

  const trimmed = search.trim()
  if (!trimmed) return null

  // 2. Trimmed exact substring.
  const trimmedIdx = haystack.indexOf(trimmed)
  if (trimmedIdx !== -1) {
    return haystack.slice(0, trimmedIdx) + replace + haystack.slice(trimmedIdx + trimmed.length)
  }

  // 3+4. Fuzzy regex: whitespace runs ⇔ &nbsp;, curly ⇔ straight quotes,
  // & ⇔ &amp; — the substitutions LLMs most often make when copying HTML.
  try {
    const re = new RegExp(buildFuzzyPattern(trimmed))
    const match = re.exec(haystack)
    if (match) {
      return haystack.slice(0, match.index) + replace + haystack.slice(match.index + match[0].length)
    }
  } catch {
    // Malformed pattern — fall through to the block-text match.
  }

  // 5. Whole-block plain-text match (tolerates dropped/altered inline tags).
  return replaceByBlockText(haystack, trimmed, replace)
}

/**
 * Apply a list of search/replace edits to a document, sequentially. Each edit
 * runs against the result of the previous one. Edits whose SEARCH text cannot
 * be located are collected in `failed` and skipped rather than applied
 * destructively, so unmatched content is never lost.
 */
export function applyEditBlocks(originalHtml: string, blocks: EditBlock[]): ApplyEditsResult {
  let html = originalHtml
  const failed: EditBlock[] = []
  for (const block of blocks) {
    const result = applyOneEdit(html, block.search, block.replace)
    if (result === null) {
      failed.push(block)
    } else {
      html = result
    }
  }
  return { html, failed }
}

/**
 * Clean up LLM-generated HTML:
 * 1. Remove blank `<p>` tags that contain only whitespace or &nbsp;.
 * 2. Collapse whitespace (including newlines) between block-level tags
 *    so that `</p>\n<p>` doesn't produce an extra blank line in TipTap.
 */
export function stripBlankParagraphs(html: string): string {
  return html
    .replace(/<p>\s*(<br\s*\/?>)?\s*<\/p>/gi, '')
    .replace(/<p>(\s|&nbsp;)+<\/p>/gi, '')
    .replace(/(<\/(p|h[1-6]|blockquote|ul|ol|li|div)>)\s+(<(p|h[1-6]|blockquote|ul|ol|li|div)[\s>])/gi, '$1$3')
}

/**
 * Count words in HTML content.
 * Handles CJK (Chinese/Japanese/Korean) characters as individual words,
 * and uses Unicode-aware word boundaries for Latin text.
 * Strips `<del>` content (deleted diff text) before counting.
 */
export function countWords(html: string): number {
  if (!html) return 0
  
  // 1. Remove <del>...</del> tags and their contents (deleted text from diffs)
  let cleanText = html.replace(/<del\b[^>]*>([\s\S]*?)<\/del>/gi, '')
  
  // 2. Replace all other HTML tags with spaces
  cleanText = cleanText.replace(/<[^>]*>/g, ' ')
  
  // 3. Replace &nbsp; and other whitespace entities with standard spaces
  cleanText = cleanText.replace(/&nbsp;/g, ' ')
  
  // 4. Decode common HTML entities to avoid counting them as words
  cleanText = cleanText
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")

  // Match CJK characters (Chinese, Japanese, Korean)
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g
  const cjkCount = (cleanText.match(cjkRegex) || []).length
  
  // Remove CJK characters to count other words (Latin, Cyrillic, Arabic, etc.)
  const nonCjkText = cleanText.replace(cjkRegex, ' ')
  
  // Match words using unicode property escapes: letters and numbers, optionally with internal apostrophe/hyphen
  const wordRegex = /[\p{L}\p{N}]+(?:[''‑][\p{L}\p{N}]+)*/gu
  const otherCount = (nonCjkText.match(wordRegex) || []).length
  
  return cjkCount + otherCount
}

/**
 * Convert a blob: URL to a data: URL via fetch + FileReader.
 */
export const convertBlobUrlToDataUrl = async (blobUrl: string): Promise<string> => {
  try {
    const res = await fetch(blobUrl)
    const blob = await res.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch (err) {
    console.error('Failed to convert blob URL to data URL:', err)
    return blobUrl
  }
}

/**
 * Convert a GIF data URL to JPEG by drawing the first frame on a canvas.
 * Returns the original URL unchanged if it's not a GIF.
 */
export const convertGifToJpegIfNeeded = (dataUrl: string): Promise<string> => {
  if (!dataUrl.startsWith('data:image/gif')) {
    return Promise.resolve(dataUrl)
  }
  return new Promise<string>((resolve) => {
    const img = new window.Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || img.width
        canvas.height = img.naturalHeight || img.height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(dataUrl)
          return
        }
        ctx.drawImage(img, 0, 0)
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9)
        resolve(jpegDataUrl)
      } catch (err) {
        console.error('Error drawing GIF to canvas:', err)
        resolve(dataUrl)
      }
    }
    img.onerror = () => {
      console.error('Error loading GIF image')
      resolve(dataUrl)
    }
    img.src = dataUrl
  })
}
