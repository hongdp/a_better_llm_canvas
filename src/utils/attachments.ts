/**
 * A book's reference files — a long novel as a .txt — as the agent reads
 * them (docs/features/attachments_and_web.md §1). Pure; mirrored by
 * scripts/wc_text/attachments.py (parity-tested).
 */

/** What the loop and the request know of an attachment. */
export interface AttachmentSection {
  title: string
  from: number
  to: number
}

export interface AttachmentMeta {
  id: string
  /** "A1", "A2"… in the book's order. */
  ref: string
  name: string
  chars: number
  paragraphs: number
  sections: AttachmentSection[]
}

/** BOM dropped, line ends made `\n`. */
export function normalizeAttachmentText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

/**
 * The text's paragraphs. A file whose blank-line-separated blocks often span
 * several lines is hard-wrapped (an English .txt): a block is a paragraph, its
 * lines joined. Otherwise every non-empty line is one (the usual Chinese
 * novel .txt, one paragraph per line, indented with full-width spaces).
 */
export function attachmentParagraphs(text: string): string[] {
  const normalized = normalizeAttachmentText(text)
  const blocks = normalized.split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(b => b.length > 0)
  const multiLine = blocks.filter(b => b.length > 1).length
  if (blocks.length > 0 && multiLine >= Math.max(3, blocks.length * 0.3)) {
    return blocks.map(lines => lines.reduce((acc, line) => {
      if (!acc) return line
      const glue = CJK_RE.test(acc[acc.length - 1]) || CJK_RE.test(line[0]) ? '' : ' '
      return acc + glue + line
    }, '')).flatMap(splitLongParagraph)
  }
  return normalized.split('\n').map(l => l.trim()).filter(Boolean).flatMap(splitLongParagraph)
}

/**
 * Longest paragraph an attachment is split into, in code points. A file
 * with no line breaks would otherwise be ONE paragraph, and every read of
 * it would be the whole file (attachments_and_web.md §1).
 */
export const MAX_PARAGRAPH_CHARS = 4000
const SENTENCE_ENDS = new Set(['。', '！', '？', '!', '?', '.', '…', '」', '”', '』', '；', ';'])

/** A paragraph past MAX_PARAGRAPH_CHARS, cut at the last sentence end in each window (code points, as Python counts). */
export function splitLongParagraph(paragraph: string): string[] {
  const chars = Array.from(paragraph)
  if (chars.length <= MAX_PARAGRAPH_CHARS) return [paragraph]
  const out: string[] = []
  let i = 0
  while (chars.length - i > MAX_PARAGRAPH_CHARS) {
    let cut = i + MAX_PARAGRAPH_CHARS
    for (let k = cut - 1; k >= i + MAX_PARAGRAPH_CHARS / 2; k--) {
      if (SENTENCE_ENDS.has(chars[k])) { cut = k + 1; break }
    }
    const piece = chars.slice(i, cut).join('').trim()
    if (piece) out.push(piece)
    i = cut
  }
  const rest = chars.slice(i).join('').trim()
  if (rest) out.push(rest)
  return out
}

const HEADING_RE = /^(?:第[零〇一二三四五六七八九十百千万两\d０-９]+[章节回卷部集篇话]|chapter\s+[\divxlc]+\b|序章|序言|楔子|引子|尾声|后记|番外)/i
const MAX_HEADING_CHARS = 40

/** Sections by their headings, with ¶ ranges; text before the first heading is an "(opening)" section. */
export function attachmentSections(paragraphs: string[]): AttachmentSection[] {
  const heads: number[] = []
  paragraphs.forEach((p, i) => { if (p.length <= MAX_HEADING_CHARS && HEADING_RE.test(p)) heads.push(i) })
  if (heads.length === 0) return []
  const out: AttachmentSection[] = []
  if (heads[0] > 0) out.push({ title: '(opening)', from: 1, to: heads[0] })
  heads.forEach((h, k) => {
    out.push({ title: paragraphs[h], from: h + 1, to: k + 1 < heads.length ? heads[k + 1] : paragraphs.length })
  })
  return out
}

/** "A2", "a2", "附件2", or the file's name (with or without its extension). */
export function resolveAttachmentRef<T extends { ref: string; name: string }>(ref: unknown, list: T[]): T | null {
  const value = String(ref ?? '').trim()
  if (!value) return null
  const m = /^(?:A|附件)\s*(\d+)$/i.exec(value)
  if (m) return list.find(a => a.ref.toLowerCase() === `a${Number(m[1])}`) ?? null
  const base = (name: string) => name.replace(/\.[^.]+$/, '')
  return list.find(a => a.name === value) ?? list.find(a => base(a.name) === value) ?? null
}

/**
 * The most attachment text one turn may read into the conversation, across
 * all reads (docs/features/attachments_and_web.md §1). A whole novel is never
 * loaded: past this, reads are refused and the model is pointed at grep and
 * at analyze_book, which reads a range of a file in batches OUTSIDE the
 * conversation and brings back notes.
 */
export const ATTACHMENT_RUN_READ_CAP = 100_000

export function attachmentBudgetNote(ref: string, used: number): string {
  return `${ref} was not read: this turn has already read ${used} characters of attachments, the most one turn may — a whole file is never read into the conversation. ` +
    `Find the passages you need with grep chapters=["${ref}"] and read only those paragraphs, or read a range with a task (chapters=["${ref}"] section="第62–87章" task="…") to get notes from batches outside the conversation.`
}

/** Lines of the index before the rest is summarized. */
export const ATTACHMENT_INDEX_LINES = 80

/** The ATTACHMENTS block of a request: each file, its size and its sections. */
export function renderAttachmentIndex(list: AttachmentMeta[], maxLines: number = ATTACHMENT_INDEX_LINES): string {
  if (list.length === 0) return ''
  const lines: string[] = []
  let hidden = 0
  for (const a of list) {
    lines.push(`${a.ref} "${a.name}" — ${a.chars} characters, ${a.paragraphs} paragraphs${a.sections.length > 0 ? `, ${a.sections.length} sections` : ''}`)
    for (const s of a.sections) {
      if (lines.length >= maxLines) { hidden++; continue }
      lines.push(`  ¶${s.from}–${s.to} ${s.title}`)
    }
  }
  return 'ATTACHMENTS (reference files the user attached to this book — not chapters: read a section with read chapters=["A1"] section="第三十章" (or a paragraph range), search with grep chapters=["A1"], or read a range with a task (chapters=["A1"] section="第62–87章" task="…") for notes; a turn reads at most 100,000 characters of them, and they cannot be written):\n' +
    lines.join('\n') + (hidden > 0 ? `\n  … ${hidden} more sections (grep for a heading to find one)` : '')
}

/**
 * An attachment as pseudo-chapters for analyze_book: a section each (the
 * whole file when it has none), cut at paragraph boundaries into pieces of at
 * most `budgetChars`.
 */
export function attachmentChunks(meta: Pick<AttachmentMeta, 'ref' | 'name'>, paragraphs: string[], budgetChars: number,
  range: { from: number; to: number } | null = null): Array<{ title: string; text: string }> {
  const sections = attachmentSections(paragraphs)
  const all = sections.length > 0 ? sections : [{ title: meta.name, from: 1, to: paragraphs.length }]
  // Only a range of the file (analyze_book section="第62–87章"): the sections in it, clipped.
  const spans = range === null ? all : all
    .filter(s => s.to >= range.from && s.from <= range.to)
    .map(s => ({ title: s.title, from: Math.max(s.from, range.from), to: Math.min(s.to, range.to, paragraphs.length) }))
  const out: Array<{ title: string; text: string }> = []
  for (const s of spans) {
    let start = s.from
    let buf: string[] = []
    let used = 0
    const flush = (end: number) => {
      if (buf.length === 0) return
      out.push({ title: `${meta.ref} "${meta.name}" — ${s.title} (¶${start}–${end})`, text: buf.join('\n') })
      buf = []
      used = 0
    }
    for (let n = s.from; n <= s.to; n++) {
      const p = paragraphs[n - 1]
      if (buf.length > 0 && used + p.length + 1 > budgetChars) { flush(n - 1); start = n }
      buf.push(p)
      used += p.length + 1
    }
    flush(s.to)
  }
  return out
}

/**
 * Paragraphs `from`–`to` of an attachment as a read returns them: numbered
 * lines up to `cap` characters, ending at a whole paragraph, with the range
 * to continue from (read_chapter's format, docs/features/attachments_and_web.md §1).
 */
export function renderAttachmentPart(meta: Pick<AttachmentMeta, 'ref' | 'name' | 'chars'>, paragraphs: string[], from: number, to: number | null, cap: number):
  { content: string; last: number; used: number } {
  const end = Math.min(to ?? paragraphs.length, paragraphs.length)
  const lines: string[] = []
  let used = 0
  let last = from - 1
  for (let n = from; n <= end; n++) {
    const line = `¶${n} ${paragraphs[n - 1]}`
    // Strict: the cap is never passed (a paragraph is at most MAX_PARAGRAPH_CHARS).
    if (used + line.length > cap) break
    lines.push(line)
    used += line.length
    last = n
  }
  const whole = from === 1 && last === paragraphs.length
  const span = whole ? '' : `, ¶${from}–¶${last} of ${paragraphs.length}`
  const more = last < end ? `\n[Stopped at ¶${last} to stay under ${cap} characters. Continue with chapters=["${meta.ref}"], paragraphs="${last + 1}-${to ?? ''}".]` : ''
  return {
    content: `=== ${meta.ref} "${meta.name}" (attachment) — ${paragraphs.length} paragraphs, ${meta.chars} characters${span} ===\n${lines.join('\n')}${more}`,
    last,
    used
  }
}

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }

/** "三十五" → 35, "一百零二" → 102, "十" → 10, "３５" → 35; null when it is not a number. */
export function parseChapterNumber(text: string): number | null {
  const value = text.trim().replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
  if (/^\d+$/.test(value)) return Number(value)
  if (!value || ![...value].every(ch => ch in CN_DIGITS || ch in CN_UNITS)) return null
  let total = 0
  let section = 0
  let digit = 0
  for (const ch of value) {
    if (ch in CN_DIGITS) { digit = CN_DIGITS[ch]; continue }
    const unit = CN_UNITS[ch]
    if (unit === 10000) { total += (section + digit) * unit; section = 0 } else { section += (digit === 0 ? 1 : digit) * unit }
    digit = 0
  }
  return total + section + digit
}

const NUMBERED_RE = /^(?:第\s*([零〇一二三四五六七八九十百千万两\d０-９]+)\s*[章节回卷部集篇话]|chapter\s+(\d+))/i

/** The chapter number a heading or a request names ("第三十章 …", "第30章", "Chapter 30", "30"), or null. */
export function sectionNumberOf(text: string): number | null {
  const value = text.trim()
  const m = NUMBERED_RE.exec(value)
  if (m) return parseChapterNumber(m[1] ?? m[2])
  return parseChapterNumber(value)
}

/**
 * The section of an attachment a request names: by its chapter number in
 * either numeral system (第三十章 = 第30章), else the first title containing
 * the words. null when none does.
 */
export function findAttachmentSection(sections: AttachmentSection[], query: string): AttachmentSection | null {
  const q = query.trim()
  if (!q) return null
  const n = sectionNumberOf(q)
  if (n !== null) {
    const hit = sections.find(s => sectionNumberOf(s.title) === n)
    if (hit) return hit
  }
  const key = q.replace(/\s+/g, '')
  return sections.find(s => s.title.replace(/\s+/g, '').includes(key)) ?? null
}

const RANGE_RE = /^第?\s*([零〇一二三四五六七八九十百千万两\d０-９]+)\s*[章节回卷部集篇话]?\s*[-–—~～至到]\s*第?\s*([零〇一二三四五六七八九十百千万两\d０-９]+)\s*[章节回卷部集篇话]?$/

/**
 * A section, or a run of numbered sections ("第62–87章", "62-87", "第六十二至八十七回"):
 * the ¶ span from the first to the last and a title naming both. Anything
 * else is looked up as one section (findAttachmentSection). null when nothing matches.
 */
export function findAttachmentRange(sections: AttachmentSection[], query: string): AttachmentSection | null {
  const q = query.trim()
  const m = RANGE_RE.exec(q)
  if (m) {
    const a = parseChapterNumber(m[1])
    const b = parseChapterNumber(m[2])
    if (a !== null && b !== null) {
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      const hits = sections.filter(s => { const n = sectionNumberOf(s.title); return n !== null && n >= lo && n <= hi })
      if (hits.length > 0) {
        return {
          title: hits.length === 1 ? hits[0].title : `${hits[0].title} … ${hits[hits.length - 1].title}`,
          from: Math.min(...hits.map(h => h.from)),
          to: Math.max(...hits.map(h => h.to))
        }
      }
    }
  }
  return findAttachmentSection(sections, q)
}

/** Sections one `list source="A1"` call shows (read_and_list.md §3). */
export const LIST_SECTION_LINES = 200

/**
 * An attachment's sections with their ¶ spans, from the `start`-th (1-based)
 * on, at most `maxLines`, and how to continue — what `list source="A1"`
 * returns, so the model can read a range by its numbers next.
 * `continueArgs` is repeated in the continue hint (e.g. ` section="第60–90章"`).
 */
export function renderSectionList(meta: Pick<AttachmentMeta, 'ref' | 'name' | 'chars' | 'paragraphs'>, sections: AttachmentSection[],
  start: number = 1, maxLines: number = LIST_SECTION_LINES, continueArgs: string = ''): string {
  const head = `=== ${meta.ref} "${meta.name}" — ${meta.paragraphs} paragraphs, ${meta.chars} characters ===`
  if (sections.length === 0) {
    return `${head}
No section headings here. Find places with grep chapters=["${meta.ref}"] and read them by ¶ (read chapters=["${meta.ref}"] paragraphs="…").`
  }
  const first = Math.max(1, Math.min(start, sections.length))
  const shown = sections.slice(first - 1, first - 1 + maxLines)
  const last = first - 1 + shown.length
  const lines = shown.map((s, i) => `${first + i}. ¶${s.from}–${s.to} ${s.title}`)
  const more = last < sections.length
    ? `\n[Sections ${first}–${last} of ${sections.length}. Continue with list source="${meta.ref}"${continueArgs} from=${last + 1}.]`
    : (first > 1 ? `\n[Sections ${first}–${last} of ${sections.length}.]` : '')
  return `${head}\n${lines.join('\n')}${more}\nRead one by its ¶ range: read chapters=["${meta.ref}"] paragraphs="a-b" (or section="…").`
}
