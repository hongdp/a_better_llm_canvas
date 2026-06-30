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
