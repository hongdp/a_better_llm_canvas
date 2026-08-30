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

// Opening marker of one Aider-style conflict block.
const EDIT_SEARCH_RE = /<{5,}\s*SEARCH[^\n]*\n/gi
// Divider between the SEARCH and REPLACE halves.
const EDIT_DIVIDER_RE = /\n={3,}[^\n]*\n/
// Anything that legitimately ends a REPLACE half. Models finish a block in
// several ways: the canonical marker, a closing </edit> tag, or by starting
// the next block. Accepting only the canonical one meant a whole edit response
// was reclassified as plain chat — raw markup dumped into the chat while the
// document stayed untouched, with no warning (the reply was too long to look
// like an empty acknowledgement).
const EDIT_TERMINATOR_RE = /\n?>{5,}\s*REPLACE[^\n]*|\n?<\/edits?\s*>|\n<{5,}\s*SEARCH/i

/**
 * Parse localized edit blocks from an LLM response.
 *
 * This is the parser for Method A (search/replace edits): rather than re-emit
 * the whole document, the model emits only the changed regions as
 * SEARCH/REPLACE pairs. Parsing is lenient — conflict markers are matched
 * whether or not they are wrapped in `<edit>` tags, the block may end at
 * `>>>>>>> REPLACE`, at `</edit>`, or where the next block begins, and the
 * surrounding `<edit>`/`<edits>` sugar is stripped from the returned chat text.
 *
 * A block whose REPLACE half runs to the end of the response with NO
 * terminator is dropped: that is a cut-off stream, and applying half a
 * replacement would silently truncate the document.
 */
export function parseEditBlocks(text: string): ParsedEdits {
  const blocks: EditBlock[] = []
  let firstStart = -1
  let lastEnd = -1

  EDIT_SEARCH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EDIT_SEARCH_RE.exec(text)) !== null) {
    const searchStart = m.index + m[0].length
    const rest = text.slice(searchStart)

    const divider = EDIT_DIVIDER_RE.exec(rest)
    if (!divider) continue

    const search = rest.slice(0, divider.index)
    const afterDividerStart = divider.index + divider[0].length
    const afterDivider = rest.slice(afterDividerStart)

    const terminator = EDIT_TERMINATOR_RE.exec(afterDivider)
    if (!terminator) continue

    if (search.trim()) {
      blocks.push({ search, replace: afterDivider.slice(0, terminator.index) })
    }
    if (firstStart === -1) firstStart = m.index
    // When the terminator IS the next block's SEARCH marker, stop short of it
    // so the following iteration still sees it.
    const startsNextBlock = /SEARCH/i.test(terminator[0])
    lastEnd = searchStart + afterDividerStart +
      (startsNextBlock ? terminator.index : terminator.index + terminator[0].length)
    EDIT_SEARCH_RE.lastIndex = lastEnd
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

/**
 * A completed LLM response classified into the action the client must take.
 * Priority (mirrors the Canvas Markup Protocol): selection_replace >
 * localized edits > full-document canvas > plain chat.
 */
export interface ParsedAssistantResponse {
  kind: 'selection' | 'edits' | 'canvas' | 'chat'
  /** Conversational text outside the action tags (before + after joined). */
  chatText: string
  /** kind === 'selection': replacement text for the user's selection. */
  selectionText: string
  /** kind === 'edits': the parsed SEARCH/REPLACE blocks. */
  editBlocks: EditBlock[]
  /** kind === 'canvas': the full replacement document HTML. */
  canvasText: string
  /** kind === 'canvas': whether the closing tag arrived (guards truncation). */
  canvasClosed: boolean
}

/**
 * Classify a COMPLETE streamed response into the action to perform. Pure —
 * the caller decides how to apply the action (diffing, editor transactions,
 * warnings).
 */
export function parseAssistantResponse(fullText: string): ParsedAssistantResponse {
  // The status trailer is protocol; it never reaches the bubble or the doc.
  fullText = stripDocStatus(fullText)
  const result: ParsedAssistantResponse = {
    kind: 'chat',
    chatText: fullText,
    selectionText: '',
    editBlocks: [],
    canvasText: '',
    canvasClosed: false
  }

  const joinAround = (before: string, after: string): string => {
    let text = before.trim()
    if (after.trim()) {
      text += (text ? '\n\n' : '') + after.trim()
    }
    return text
  }

  const selectionBlock = extractTaggedBlock(fullText, 'selection_replace')
  const parsedEdits = parseEditBlocks(fullText)
  const canvasBlock = extractTaggedBlock(fullText, 'canvas')

  if (selectionBlock.found) {
    result.kind = 'selection'
    result.selectionText = selectionBlock.inner
    result.chatText = joinAround(selectionBlock.before, selectionBlock.after)
  } else if (parsedEdits.blocks.length > 0) {
    result.kind = 'edits'
    result.editBlocks = parsedEdits.blocks
    result.chatText = joinAround(parsedEdits.before, parsedEdits.after)
  } else if (canvasBlock.found) {
    result.kind = 'canvas'
    result.canvasText = canvasBlock.inner
    result.canvasClosed = canvasBlock.closed
    result.chatText = joinAround(canvasBlock.before, canvasBlock.after)
  }

  return result
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

/**
 * Detect a response that claims (or implies) a document change but produced
 * none — the "chat says it wrote the chapter, the document is untouched"
 * failure.
 *
 * Only meaningful when the response carried no action tags at all
 * (`parseAssistantResponse(...).kind === 'chat'`); the caller checks that.
 *
 * Problem / Root Cause / Fix:
 * - Problem: a write request comes back as a one-line acknowledgement with no
 *   <canvas>/<edit>/<selection_replace> tags, so nothing reaches the editor
 *   while the chat bubble reads like a success.
 * - Root cause: tag compliance is probabilistic. Measured against grok-4.5
 *   (2026-07-25, n=37 across conditions), the failure occurs with the system
 *   prompt preset disabled and with no chat history, and the success rate for
 *   an identical prompt drifted between 22% and 65% inside one hour — no
 *   prompt wording moved it beyond the noise.
 * - Fix: recover client-side instead of instructing harder. The caller retries
 *   the turn once with a corrective instruction and, if that also comes back
 *   empty-handed, warns the user rather than reporting success.
 *
 * Deliberately narrow, because a false positive costs an extra LLM call:
 * a genuine chat answer is usually longer, and a clarifying question (the
 * legitimate short reply) ends in a question mark.
 */
/**
 * Phrases where the model asserts it changed the document. Detecting the
 * CLAIM is the point: whether an edit was warranted is the model's call, but
 * "I updated it" with no markup is always a broken turn.
 */
/**
 * The model's own declaration of what it did to the document.
 *
 * Every reply ends with `<doc_status>updated|unchanged</doc_status>` (see
 * systemPrompt.ts). This is the ONLY reliable read on intent: the client
 * cannot know whether a request warranted an edit, and matching prose in two
 * languages only ever approximated it. A declaration that disagrees with the
 * emitted markup is the failure we actually want to catch.
 *
 * Returns null when the model omitted the trailer, which older/smaller models
 * do — callers fall back to the prose heuristic below.
 */
const DOC_STATUS_RE = /<doc_status>\s*(updated|unchanged)\s*<\/doc_status>/i

export type DocStatusDeclaration = 'updated' | 'unchanged'

export function parseDocStatus(fullText: string): DocStatusDeclaration | null {
  const m = DOC_STATUS_RE.exec(fullText || '')
  return m ? (m[1].toLowerCase() as DocStatusDeclaration) : null
}

/**
 * Remove the declaration from text headed for the chat bubble — it is
 * protocol, not something the user should read. Also swallows a trailer that
 * is still arriving, so it does not flicker through the live bubble one
 * character at a time.
 */
const TRAILER_OPEN = '<doc_status>'
const TRAILER_CLOSE = '</doc_status>'

/** Is this trailing fragment the beginning of a declaration and nothing else? */
function isPartialTrailer(tail: string): boolean {
  const t = tail.toLowerCase()
  if (TRAILER_OPEN.startsWith(t)) return true
  const m = /^<doc_status>\s*([a-z]*)(<\/?[a-z_]*)?$/.exec(t)
  if (!m) return false
  const [, word, close] = m
  if (word && !'updated'.startsWith(word) && !'unchanged'.startsWith(word)) return false
  if (close && !TRAILER_CLOSE.startsWith(close)) return false
  return true
}

export function stripDocStatus(text: string): string {
  let out = (text || '').replace(DOC_STATUS_RE, '')
  const lt = out.lastIndexOf('<')
  // A lone '<' is indistinguishable from prose, so it is left alone; it is
  // visible for at most one chunk.
  if (lt !== -1 && lt < out.length - 1 && isPartialTrailer(out.slice(lt))) {
    out = out.slice(0, lt)
  }
  return out.trimEnd()
}

/**
 * First-person claims of having written.
 *
 * Deliberately narrow. It is used ONLY to catch a reply that declares
 * "unchanged" while telling the user it changed something — a model
 * describing what the USER did ("你已经把这段改好了") must stay out of it.
 * The broader prose heuristic this replaced is gone: with the declaration
 * mandatory, an undeclared reply is a protocol failure on its own and no
 * amount of pattern-matching prose is needed to reach that verdict.
 */
const SELF_CLAIM_PATTERNS = [
  /\bi(?:'ve| have)?\s+(?:just\s+)?(?:updated|rewritten|rewrote|revised|edited|expanded|added|inserted|removed|deleted|replaced|continued|drafted)\b/i,
  /\bhere(?:'s| is)\s+the\s+(?:updated|revised|rewritten|new)\b/i,
  /我已(?:经)?[^。！？；\n]{0,10}?(?:更新|改写|重写|修改|润色|扩写|续写|写好|写完|写入|改好|补上|添加|删除|替换)/,
  // The lookbehind is load-bearing: "你已经把第二章改好了" is the model
  // describing the USER's edit, not claiming its own.
  /(?<![你您])已(?:经)?(?:帮你|为你|把|将)[^。！？；\n]{0,10}?(?:更新|改写|重写|修改|润色|扩写|续写|写好|写完|写入|改好|补上|添加|删除|替换)/
]


/**
 * Did this reply FAIL to deliver a document update it should have delivered?
 *
 * Two failure modes, both about the model's own output rather than about what
 * the user asked for:
 *  - 'malformed' — edit markup that the parser rejected. The model tried to
 *    edit and got the shape wrong.
 *  - 'claimed'   — the model states it changed the document while emitting no
 *    document markup at all.
 *
 * Deliberately NOT a guess at user intent. An earlier version retried any
 * short reply, so ordinary conversation ("does this read well?") burned three
 * extra generations and ended in a warning about a failure that never
 * happened. Whether an edit is warranted is the model's call; what the client
 * can judge is whether the model's own claim matches its own output.
 *
 * Callers pass the FULL response text and only ask when no document action
 * was parsed out of it.
 */
export type DocumentUpdateFailure = 'malformed' | 'claimed' | 'undeclared'

export function detectFailedDocumentUpdate(fullText: string): DocumentUpdateFailure | null {
  const text = (fullText || '').trim()
  if (!text) return null
  if (/<edits?\b|<{5,}\s*SEARCH/i.test(text)) return 'malformed'
  // An unclosed action tag: the model started the markup and never finished.
  if (/<(?:canvas|selection_replace)\b/i.test(text)) return 'malformed'

  const declared = parseDocStatus(text)

  // Declared an update and emitted nothing — the failure this exists for.
  if (declared === 'updated') return 'claimed'

  if (declared === 'unchanged') {
    // Normally authoritative, and deliberately so: it silences prose that only
    // DESCRIBES an edit ("你已经把这段改好了"). But a first-person claim of
    // having written, next to a declaration of having written nothing, is the
    // model contradicting itself — and that contradiction is exactly what the
    // user sees as "it said it wrote and it didn't".
    return SELF_CLAIM_PATTERNS.some(re => re.test(text)) ? 'claimed' : null
  }

  // No declaration at all. The protocol requires one on EVERY reply, including
  // replies that change nothing, precisely so that "no markup" is never
  // ambiguous: without it a model that silently skipped the work is
  // indistinguishable from one that deliberately answered in chat.
  return 'undeclared'
}

/**
 * Drop a trailing partial HTML tag or entity from a mid-stream fragment.
 *
 * Streamed `<canvas>` content is rendered into the editor as it arrives, so
 * the tail is routinely cut mid-token (`<p>The sleek ta`, `<h`, `&nbs`).
 * Feeding that to the DOM parser makes the last element flicker between
 * garbage states; trimming to the last complete construct keeps the live
 * preview stable. Unclosed *elements* are fine — the parser closes them.
 */
export function trimIncompleteHtmlTail(html: string): string {
  let out = html
  const lastLt = out.lastIndexOf('<')
  if (lastLt !== -1 && out.indexOf('>', lastLt) === -1) {
    out = out.slice(0, lastLt)
  }
  const lastAmp = out.lastIndexOf('&')
  if (lastAmp !== -1 && out.indexOf(';', lastAmp) === -1 && out.length - lastAmp <= 10) {
    out = out.slice(0, lastAmp)
  }
  return out
}
