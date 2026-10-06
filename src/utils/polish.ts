/**
 * Polish pass, the pure half (agentic_chat_loop.md D9): split a chapter into
 * chunks, build each chunk's prompt, parse the rewrite, validate it, and put
 * the chapter back together.
 *
 * Only plain paragraphs are rewritten. Headings, images and any other block
 * stay exactly as they are and also end a chunk, so a rewrite can never lose
 * them. (The measuring harness flattened the chapter to plain text first; a
 * product cannot, or a polish would strip every heading, image and bold.)
 *
 * The validation mirrors the tuning session's measurement — same dialogue
 * pattern, same clause breaks, same "bare" character count — so its measured
 * thresholds apply: 51 chunks, length −2.8%…+27.9%, and these bounds sent
 * 2 of 51 back to their draft (4%). A chunk that fails keeps its draft.
 */

import { topLevelBlocks } from './paragraphs'

/** Target chunk size, in plain-text characters (the measured setup). */
export const POLISH_CHUNK_CHARS = 1000
/** Length ratio a rewrite may have, measured on bare characters. */
export const POLISH_LENGTH_MIN = 0.9
export const POLISH_LENGTH_MAX = 1.3
/** Longest unbroken narration clause, in bare characters. Human posts peak at 28–43. */
export const POLISH_MAX_CLAUSE = 30

/** Punctuation and whitespace the measurement does not count (metrics.py PUNCT). */
const PUNCT_RE = /[，。！？、；：…—「」“”‘’（）《》\s·,.!?]/g
/** Clause breaks (chunkstats.py BREAK). */
const BREAK_RE = /[，,。！？!?；;：:…—]+/
const DIALOGUE_RE = /“([^”]{2,})”/g

export const bare = (s: string) => s.replace(PUNCT_RE, '')

const decodeEntities = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const textOf = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, '')).trim()

/** A run of paragraphs rewritten together, or a block kept as it is. */
export type PolishSegment =
  | { kind: 'fixed'; html: string }
  | { kind: 'chunk'; paras: string[] }

/**
 * Split a chapter into chunks of whole paragraphs (≈ `target` chars each)
 * and the blocks between them that are never rewritten.
 */
export function splitForPolish(html: string, target = POLISH_CHUNK_CHARS): PolishSegment[] {
  const segments: PolishSegment[] = []
  let current: string[] = []
  const flush = () => {
    if (current.length > 0) segments.push({ kind: 'chunk', paras: current })
    current = []
  }
  for (const block of topLevelBlocks(html)) {
    const m = /^<p(?:\s[^>]*)?>([\s\S]*)<\/p>$/i.exec(block)
    // A paragraph holding an image (or its placeholder token) is kept whole.
    const plain = m && !/<img\b|\{\{IMAGE_PLACEHOLDER_\d+\}\}/i.test(m[1]) ? m[1] : null
    if (plain === null || !textOf(plain)) {
      flush()
      segments.push({ kind: 'fixed', html: block })
      continue
    }
    current.push(plain)
    if (textOf(current.join('')).length >= target) flush()
  }
  flush()
  return segments
}

/** The prompt pieces a user can edit (Settings), with the measured default. */
export interface PolishPrompt {
  /** System prompt; the user's active writing preset is appended to it. */
  system: string
  /** User prompt: {n} chunk size, {prev} last sentence before it, {part} the chunk. */
  template: string
}

/** The last sentence of a chunk's text — the next chunk's continuity hint. */
function lastSentence(paras: string[]): string {
  const text = textOf(paras[paras.length - 1] ?? '')
  const sentences = text.match(/[^。！？!?]+[。！？!?…”」]*/g) ?? [text]
  return (sentences[sentences.length - 1] ?? text).trim()
}

export function buildPolishPrompt(template: string, chunk: string[], previous: string[] | null): string {
  const part = chunk.map(p => `<p>${p}</p>`).join('\n')
  return template
    .replace(/\{n\}/g, String(bare(textOf(chunk.join(''))).length))
    .replace(/\{prev\}/g, previous ? lastSentence(previous) : '（本段是开头）')
    .replace(/\{part\}/g, part)
}

/** The rewrite's paragraphs (inner HTML), from `<p>` tags or, failing that, lines. */
export function parsePolished(output: string): string[] {
  const tagged = [...output.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)].map(m => m[1].trim())
  const paras = tagged.length > 0 ? tagged : output.split('\n').map(l => l.trim())
  return paras.filter(p => textOf(p))
}

export interface PolishCheck {
  ok: boolean
  /** Why it failed, for the trace ("dialogue changed", "length +34%", …). */
  reasons: string[]
  /** bare length out / bare length in. */
  ratio: number
}

/** Validate one rewritten chunk against its draft. */
export function validatePolished(draft: string[], rewrite: string[]): PolishCheck {
  const inText = draft.map(textOf).join('')
  const outText = rewrite.map(textOf).join('')
  const inLen = bare(inText).length
  const ratio = inLen > 0 ? bare(outText).length / inLen : 0
  const reasons: string[] = []

  if (rewrite.length === 0) reasons.push('empty rewrite')
  if (ratio < POLISH_LENGTH_MIN || ratio > POLISH_LENGTH_MAX) {
    reasons.push(`length ${ratio >= 1 ? '+' : ''}${Math.round((ratio - 1) * 100)}%`)
  }
  const outBare = bare(outText)
  const lost = [...inText.matchAll(DIALOGUE_RE)].filter(m => !outBare.includes(bare(m[1])))
  if (lost.length > 0) reasons.push(`${lost.length} dialogue line(s) changed`)
  const longest = Math.max(0, ...rewrite.flatMap(p =>
    textOf(p).replace(/“[^”]*”/g, '').split(BREAK_RE).map(c => bare(c).length)))
  if (longest > POLISH_MAX_CLAUSE) reasons.push(`${longest}-char run-on`)
  // Two paragraphs merged into one is fine (measured twice in 51 chunks).
  if (rewrite.length < draft.length - 1) reasons.push(`${draft.length - rewrite.length} paragraphs lost`)

  return { ok: reasons.length === 0, reasons, ratio }
}

/** Reassemble the chapter: each chunk's rewrite, or its draft where none passed. */
export function assemblePolished(segments: PolishSegment[], rewrites: Array<string[] | null>): string {
  let chunk = 0
  return segments.map(seg => {
    if (seg.kind === 'fixed') return seg.html
    const out = rewrites[chunk++]
    return (out ?? seg.paras).map(p => `<p>${p}</p>`).join('')
  }).join('')
}
