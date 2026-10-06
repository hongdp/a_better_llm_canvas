/**
 * A chapter as numbered paragraphs — prose's equivalent of a source file's
 * lines (agentic_chat_loop.md, "Paragraphs as lines").
 *
 * Coding agents read files with line numbers (Claude Code's Read prints
 * `cat -n`; Codex reads ranges with `sed -n`) so a model can cite a place,
 * grep to it and read only around it. A novel has no meaningful lines; its
 * unit is the paragraph, i.e. a top-level block of the chapter's HTML. The
 * numbering is 1-based and counts every non-empty block, headings and images
 * included, so a number means the same thing to grep, read_chapter and the
 * user.
 */

export interface ChapterParagraph {
  /** 1-based position among the chapter's paragraphs. */
  number: number
  /** The block's own HTML, exactly as stored. */
  html: string
  /** Its plain text ('' for an image). */
  text: string
  kind: 'paragraph' | 'heading' | 'image' | 'other'
}

const decodeEntities = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** A block's plain text: tags dropped, list items and line breaks kept apart. */
export const blockText = (html: string) => decodeEntities(
  html
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
).replace(/[ \t]+\n/g, '\n').trim()

const IMAGE_RE = /<img\b|\{\{IMAGE_PLACEHOLDER_\d+\}\}/i

/** Top-level blocks of a chapter's HTML, in order; loose text becomes a `<p>`. */
export function topLevelBlocks(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return [...doc.body.childNodes].flatMap(node => {
    if (node.nodeType === Node.ELEMENT_NODE) return [(node as Element).outerHTML]
    const text = node.textContent?.trim()
    return text ? [`<p>${text}</p>`] : []
  })
}

export function chapterParagraphs(html: string): ChapterParagraph[] {
  let number = 0
  return topLevelBlocks(html).flatMap(block => {
    // An image placeholder token is an image, not words.
    const text = blockText(block).replace(/\{\{IMAGE_PLACEHOLDER_\d+\}\}/g, '').trim()
    const image = IMAGE_RE.test(block)
    if (!text && !image) return []
    number++
    const kind: ChapterParagraph['kind'] = /^<h[1-6]\b/i.test(block) ? 'heading'
      : image && !text ? 'image'
      : /^<p\b/i.test(block) ? 'paragraph'
      : 'other'
    return [{ number, html: block, text, kind }]
  })
}

/**
 * A chapter's length the way the read tools state it: the characters of its
 * paragraphs' text. Write results use the same count, so a model can compare
 * what it wrote with what it read ("¶869–¶933 (3585 characters)").
 */
export const chapterChars = (html: string) =>
  chapterParagraphs(html).reduce((sum, p) => sum + p.text.length, 0)

/** One numbered line of a text-format read: "¶12 …", headings marked "#". */
export function numberedLine(p: ChapterParagraph): string {
  if (p.kind === 'image') return `¶${p.number} [image]`
  return `¶${p.number} ${p.kind === 'heading' ? '# ' : ''}${p.text.replace(/\n+/g, ' / ')}`
}
