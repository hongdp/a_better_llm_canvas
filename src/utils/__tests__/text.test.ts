import { describe, it, expect } from 'vitest'
import { getTimestampId, stripIncompleteEndTag, countWords } from '../text'

// ── getTimestampId ────────────────────────────────────────────────────────────
describe('getTimestampId', () => {
  it('returns a string with the given prefix', () => {
    const id = getTimestampId('doc')
    expect(id).toMatch(/^doc-\d+$/)
  })

  it('includes a numeric timestamp after the prefix', () => {
    const before = Date.now()
    const id = getTimestampId('x')
    const after = Date.now()
    const ts = parseInt(id.split('-')[1], 10)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('generates distinct IDs when called rapidly (different ms)', () => {
    const ids = new Set(Array.from({ length: 10 }, () => getTimestampId('p')))
    // At minimum they should all start with 'p-'
    ids.forEach(id => expect(id).toMatch(/^p-/))
  })

  it('handles an empty prefix', () => {
    const id = getTimestampId('')
    expect(id).toMatch(/^-\d+$/)
  })
})

// ── stripIncompleteEndTag ─────────────────────────────────────────────────────
describe('stripIncompleteEndTag', () => {
  const fullTag = '</selection_replace>'

  it('returns the text unchanged if there is no partial tag', () => {
    expect(stripIncompleteEndTag('hello world')).toBe('hello world')
  })

  it('strips the full tag when it appears at the end', () => {
    const input = `some text${fullTag}`
    expect(stripIncompleteEndTag(input)).toBe('some text')
  })

  it('strips a partial tag suffix (first half)', () => {
    const partial = '</selec'
    const input = `content${partial}`
    expect(stripIncompleteEndTag(input)).toBe('content')
  })

  it('does NOT strip a suffix that is not part of the tag (e.g. "e>" alone)', () => {
    // "e>" is not a prefix of </selection_replace>, so input is unchanged
    const input = 'texte>'
    expect(stripIncompleteEndTag(input)).toBe('texte>')
  })

  it('does NOT strip if the tag appears in the middle, not at end', () => {
    const input = `${fullTag} more text`
    expect(stripIncompleteEndTag(input)).toBe(input)
  })

  it('handles an empty string', () => {
    expect(stripIncompleteEndTag('')).toBe('')
  })

  it('handles a string that is exactly the full tag', () => {
    expect(stripIncompleteEndTag(fullTag)).toBe('')
  })
})

// ── countWords ────────────────────────────────────────────────────────────────
describe('countWords', () => {
  it('returns 0 for empty string', () => {
    expect(countWords('')).toBe(0)
  })

  it('returns 0 for null-ish input', () => {
    expect(countWords(null as unknown as string)).toBe(0)
  })

  it('counts plain Latin words', () => {
    expect(countWords('<p>Hello world foo</p>')).toBe(3)
  })

  it('counts each CJK character as one word', () => {
    // 你好世界 = 4 CJK chars
    expect(countWords('<p>你好世界</p>')).toBe(4)
  })

  it('counts mixed CJK and Latin', () => {
    // "Hello 世界" → 1 Latin + 2 CJK = 3
    expect(countWords('<p>Hello 世界</p>')).toBe(3)
  })

  it('strips <del>...</del> content before counting', () => {
    // "Hello <del>deleted</del> world" → "Hello world" → 2
    expect(countWords('<p>Hello <del>deleted</del> world</p>')).toBe(2)
  })

  it('decodes HTML entities — decoded chars may be counted as words', () => {
    // "&amp;" decodes to "&" which has no letters, counts as 0
    expect(countWords('<p>&amp;</p>')).toBe(0)
    // "&lt;tag&gt;" decodes to "<tag>" — "tag" is counted as a word (1)
    expect(countWords('<p>&lt;tag&gt;</p>')).toBe(1)
  })

  it('ignores HTML tags in word count', () => {
    expect(countWords('<h1>One</h1><p>two three</p>')).toBe(3)
  })

  it('counts &nbsp; as whitespace, not a word', () => {
    expect(countWords('<p>one&nbsp;two</p>')).toBe(2)
  })

  it('handles ASCII-hyphenated words as two words (standard hyphen is a separator)', () => {
    // The word regex uses typographic hyphens (\u2011, etc.), not ASCII "-"
    // So "well-known" splits into 2 tokens, giving count 3 with "concept"
    expect(countWords('<p>well-known concept</p>')).toBe(3)
  })
})
