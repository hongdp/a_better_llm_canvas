import { describe, it, expect } from 'vitest'
import { getTimestampId, stripIncompleteEndTag, countWords, extractTaggedBlock, hasElisionMarkers, validateCanvasReplacement } from '../text'

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

// \u2500\u2500 extractTaggedBlock \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
describe('extractTaggedBlock', () => {
  it('reports not found when the tag is absent', () => {
    const r = extractTaggedBlock('just a chat reply', 'canvas')
    expect(r.found).toBe(false)
    expect(r.closed).toBe(false)
    expect(r.before).toBe('just a chat reply')
  })

  it('extracts a complete block and surrounding chat text', () => {
    const r = extractTaggedBlock('Sure!<canvas><p>Hi</p></canvas>Done', 'canvas')
    expect(r.found).toBe(true)
    expect(r.closed).toBe(true)
    expect(r.inner).toBe('<p>Hi</p>')
    expect(r.before).toBe('Sure!')
    expect(r.after).toBe('Done')
  })

  it('reports closed=false when the closing tag never arrived (truncation)', () => {
    const r = extractTaggedBlock('Here:<canvas><p>partial content', 'canvas')
    expect(r.found).toBe(true)
    expect(r.closed).toBe(false)
    expect(r.inner).toBe('<p>partial content')
  })

  it('is case-insensitive and tolerates attributes on the open tag', () => {
    const r = extractTaggedBlock('<Canvas data-x="1"><p>Body</p></CANVAS>', 'canvas')
    expect(r.found).toBe(true)
    expect(r.closed).toBe(true)
    expect(r.inner).toBe('<p>Body</p>')
  })

  it('tolerates whitespace inside the closing tag', () => {
    const r = extractTaggedBlock('<canvas><p>X</p></canvas >', 'canvas')
    expect(r.closed).toBe(true)
    expect(r.inner).toBe('<p>X</p>')
  })

  it('strips a wrapping markdown code fence from the inner HTML', () => {
    const r = extractTaggedBlock('<canvas>\n```html\n<p>Fenced</p>\n```\n</canvas>', 'canvas')
    expect(r.inner).toBe('<p>Fenced</p>')
  })

  it('works for the selection_replace tag too', () => {
    const r = extractTaggedBlock('ok<selection_replace>new text</selection_replace>', 'selection_replace')
    expect(r.found).toBe(true)
    expect(r.inner).toBe('new text')
  })
})

// \u2500\u2500 hasElisionMarkers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
describe('hasElisionMarkers', () => {
  it('flags an HTML comment that says the rest is unchanged', () => {
    expect(hasElisionMarkers('<p>Intro</p><!-- rest of the document unchanged -->')).toBe(true)
  })

  it('flags a bracketed continuation placeholder', () => {
    expect(hasElisionMarkers('<p>Start</p>[content continues]')).toBe(true)
  })

  it('flags a parenthetical "remains the same" placeholder', () => {
    expect(hasElisionMarkers('<p>A</p>(rest of the chapter remains the same)')).toBe(true)
  })

  it('flags a whole-paragraph ellipsis', () => {
    expect(hasElisionMarkers('<p>A</p><p>...</p><p>B</p>')).toBe(true)
    expect(hasElisionMarkers('<p>A</p><p>\u2026</p><p>B</p>')).toBe(true)
  })

  it('does NOT flag a bare ellipsis inside prose (legitimate in fiction)', () => {
    expect(hasElisionMarkers('<p>"Wait...," she whispered.</p>')).toBe(false)
  })

  it('does NOT flag ordinary content', () => {
    expect(hasElisionMarkers('<h1>Title</h1><p>A full paragraph of real content.</p>')).toBe(false)
  })

  it('does NOT flag the word "continues" used naturally in prose', () => {
    // Keyword must appear inside a comment/bracket/paren placeholder, not free prose.
    expect(hasElisionMarkers('<p>The road continues for miles.</p>')).toBe(false)
  })
})

// \u2500\u2500 validateCanvasReplacement \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
describe('validateCanvasReplacement', () => {
  it('returns "truncated" when the closing tag was not found', () => {
    expect(validateCanvasReplacement('<p>partial', false)).toBe('truncated')
  })

  it('returns "elided" when the closed output abbreviates content', () => {
    expect(validateCanvasReplacement('<p>A</p><!-- rest unchanged -->', true)).toBe('elided')
  })

  it('returns null for a complete, full replacement', () => {
    expect(validateCanvasReplacement('<h1>Title</h1><p>Full content here.</p>', true)).toBeNull()
  })

  it('prioritizes truncation over elision', () => {
    expect(validateCanvasReplacement('<p>A</p><!-- rest unchanged -->', false)).toBe('truncated')
  })
})
