import { describe, it, expect } from 'vitest'
import { getTimestampId, stripIncompleteEndTag, countWords, extractTaggedBlock, hasElisionMarkers, validateCanvasReplacement, parseEditBlocks, applyEditBlocks, parseLookupRequest } from '../text'

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

// ── parseEditBlocks ───────────────────────────────────────────────────────────
describe('parseEditBlocks', () => {
  const block = (search: string, replace: string) =>
    `<edit>\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n</edit>`

  it('returns no blocks when there are no markers', () => {
    const r = parseEditBlocks('just a normal chat reply')
    expect(r.blocks).toHaveLength(0)
  })

  it('parses a single edit block with search and replace', () => {
    const r = parseEditBlocks(block('<p>old</p>', '<p>new</p>'))
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0].search).toBe('<p>old</p>')
    expect(r.blocks[0].replace).toBe('<p>new</p>')
  })

  it('parses multiple edit blocks', () => {
    const text = block('<p>a</p>', '<p>A</p>') + '\n' + block('<p>b</p>', '<p>B</p>')
    const r = parseEditBlocks(text)
    expect(r.blocks).toHaveLength(2)
    expect(r.blocks[1].search).toBe('<p>b</p>')
    expect(r.blocks[1].replace).toBe('<p>B</p>')
  })

  it('captures chat text before and after the edit region, stripping <edit> sugar', () => {
    const text = `Here is the change.\n${block('<p>x</p>', '<p>y</p>')}\nLet me know!`
    const r = parseEditBlocks(text)
    expect(r.before).toBe('Here is the change.')
    expect(r.after).toBe('Let me know!')
  })

  it('parses an empty REPLACE as a deletion', () => {
    const text = `<edit>\n<<<<<<< SEARCH\n<p>remove me</p>\n=======\n\n>>>>>>> REPLACE\n</edit>`
    const r = parseEditBlocks(text)
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0].search).toBe('<p>remove me</p>')
    expect(r.blocks[0].replace.trim()).toBe('')
  })

  it('parses conflict markers even without <edit> wrapper tags', () => {
    const text = `<<<<<<< SEARCH\n<p>raw</p>\n=======\n<p>wrapped</p>\n>>>>>>> REPLACE`
    const r = parseEditBlocks(text)
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0].search).toBe('<p>raw</p>')
  })

  it('ignores a block whose SEARCH is blank', () => {
    const text = `<<<<<<< SEARCH\n   \n=======\n<p>new</p>\n>>>>>>> REPLACE`
    const r = parseEditBlocks(text)
    expect(r.blocks).toHaveLength(0)
  })
})

// ── applyEditBlocks ───────────────────────────────────────────────────────────
describe('applyEditBlocks', () => {
  it('applies an exact-match edit', () => {
    const r = applyEditBlocks('<p>a</p><p>b</p>', [{ search: '<p>a</p>', replace: '<p>A</p>' }])
    expect(r.html).toBe('<p>A</p><p>b</p>')
    expect(r.failed).toHaveLength(0)
  })

  it('reports an edit whose SEARCH is not found, leaving the doc unchanged', () => {
    const r = applyEditBlocks('<p>a</p>', [{ search: '<p>missing</p>', replace: '<p>X</p>' }])
    expect(r.html).toBe('<p>a</p>')
    expect(r.failed).toHaveLength(1)
  })

  it('matches despite whitespace differences (newlines / indentation)', () => {
    const original = '<p>hello</p>\n<p>world</p>'
    // Model emits the search with different internal whitespace.
    const r = applyEditBlocks(original, [{ search: '<p>hello</p> <p>world</p>', replace: '<p>done</p>' }])
    expect(r.html).toBe('<p>done</p>')
    expect(r.failed).toHaveLength(0)
  })

  it('trims surrounding whitespace on the search text', () => {
    const r = applyEditBlocks('<p>keep</p>', [{ search: '\n  <p>keep</p>  \n', replace: '<p>kept</p>' }])
    expect(r.html).toBe('<p>kept</p>')
  })

  it('applies multiple edits sequentially', () => {
    const r = applyEditBlocks('<p>a</p><p>b</p><p>c</p>', [
      { search: '<p>a</p>', replace: '<p>A</p>' },
      { search: '<p>c</p>', replace: '<p>C</p>' }
    ])
    expect(r.html).toBe('<p>A</p><p>b</p><p>C</p>')
    expect(r.failed).toHaveLength(0)
  })

  it('applies matched edits and skips unmatched ones in the same batch', () => {
    const r = applyEditBlocks('<p>a</p><p>b</p>', [
      { search: '<p>a</p>', replace: '<p>A</p>' },
      { search: '<p>zzz</p>', replace: '<p>Z</p>' }
    ])
    expect(r.html).toBe('<p>A</p><p>b</p>')
    expect(r.failed).toHaveLength(1)
  })

  it('handles a deletion (empty replace)', () => {
    const r = applyEditBlocks('<p>a</p><p>b</p>', [{ search: '<p>a</p>', replace: '' }])
    expect(r.html).toBe('<p>b</p>')
  })

  it('does not treat $ in replacement as a special token', () => {
    const r = applyEditBlocks('<p>price</p>', [{ search: '<p>price</p>', replace: '<p>$5 & $10</p>' }])
    expect(r.html).toBe('<p>$5 & $10</p>')
  })

  // ── fuzzy level 4: entity / quote equivalence ──────────────────────────────
  it('matches when the doc has &nbsp; but the search has a plain space', () => {
    const r = applyEditBlocks('<p>hello&nbsp;world</p>', [{ search: '<p>hello world</p>', replace: '<p>hi</p>' }])
    expect(r.html).toBe('<p>hi</p>')
    expect(r.failed).toHaveLength(0)
  })

  it('matches when the doc has curly quotes but the search has straight quotes', () => {
    const r = applyEditBlocks('<p>she said “hi” and it’s fine</p>', [
      { search: `<p>she said "hi" and it's fine</p>`, replace: '<p>ok</p>' }
    ])
    expect(r.html).toBe('<p>ok</p>')
    expect(r.failed).toHaveLength(0)
  })

  it('matches when the doc has &amp; but the search has a bare &', () => {
    const r = applyEditBlocks('<p>salt &amp; pepper</p>', [{ search: '<p>salt & pepper</p>', replace: '<p>spices</p>' }])
    expect(r.html).toBe('<p>spices</p>')
    expect(r.failed).toHaveLength(0)
  })

  it('matches when doc has &#39; but the search has a curly apostrophe', () => {
    const r = applyEditBlocks('<p>it&#39;s here</p>', [{ search: '<p>it’s here</p>', replace: '<p>found</p>' }])
    expect(r.html).toBe('<p>found</p>')
    expect(r.failed).toHaveLength(0)
  })

  // ── fuzzy level 5: whole-block plain-text match ────────────────────────────
  it('matches a whole block even when the search dropped inline tags', () => {
    const doc = '<p>keep</p><p>The <strong>bold</strong> truth stays.</p><p>tail</p>'
    // Model copied the paragraph text but lost the <strong> markup.
    const r = applyEditBlocks(doc, [{ search: '<p>The bold truth stays.</p>', replace: '<p>Rewritten.</p>' }])
    expect(r.html).toBe('<p>keep</p><p>Rewritten.</p><p>tail</p>')
    expect(r.failed).toHaveLength(0)
  })

  it('matches a run of blocks by text when attributes differ', () => {
    const doc = '<h2 id="x">Title</h2><p class="lead">First para.</p><p>after</p>'
    // Model re-emitted the tags without the attributes.
    const r = applyEditBlocks(doc, [
      { search: '<h2>Title</h2><p>First para.</p>', replace: '<h2>New</h2><p>Changed.</p>' }
    ])
    expect(r.html).toBe('<h2>New</h2><p>Changed.</p><p>after</p>')
    expect(r.failed).toHaveLength(0)
  })

  it('block-text match replaces whole blocks only — partial-paragraph text does not match', () => {
    const doc = '<p>alpha beta gamma</p>'
    const r = applyEditBlocks(doc, [{ search: 'beta', replace: 'BETA' }])
    // 'beta' matches as a plain substring (level 1), so it applies directly…
    expect(r.html).toBe('<p>alpha BETA gamma</p>')
    // …but a *paragraph-wrapped* partial text must not swap the whole block.
    const r2 = applyEditBlocks(doc, [{ search: '<p>alpha beta</p>', replace: '<p>X</p>' }])
    expect(r2.failed).toHaveLength(1)
    expect(r2.html).toBe(doc)
  })

  it('still fails cleanly when the text genuinely is not in the document', () => {
    const r = applyEditBlocks('<p>real content</p>', [
      { search: '<p>hallucinated content</p>', replace: '<p>X</p>' }
    ])
    expect(r.failed).toHaveLength(1)
    expect(r.html).toBe('<p>real content</p>')
  })
})

// ── parseLookupRequest ────────────────────────────────────────────────────────
describe('parseLookupRequest', () => {
  it('parses a clean lookup tag with multiple titles', () => {
    const r = parseLookupRequest('<lookup chapters="Chapter 3: Ashfall; Chapter 7: Return" reason="continuity"></lookup>')
    expect(r).toEqual({ titles: ['Chapter 3: Ashfall', 'Chapter 7: Return'], wantsAll: false, reason: 'continuity' })
  })

  it('parses a self-closing tag and single quotes', () => {
    const r = parseLookupRequest("<lookup chapters='Chapter 1' reason='check names'/>")
    expect(r).toEqual({ titles: ['Chapter 1'], wantsAll: false, reason: 'check names' })
  })

  it('tolerates brief surrounding prose', () => {
    const r = parseLookupRequest('Let me check that chapter first.\n<lookup chapters="Chapter 2"></lookup>')
    expect(r?.titles).toEqual(['Chapter 2'])
  })

  it('parses the whole-book request', () => {
    const r = parseLookupRequest('<lookup chapters="*" reason="full outline"></lookup>')
    expect(r).toEqual({ titles: [], wantsAll: true, reason: 'full outline' })
  })

  it('returns null when there is no lookup tag', () => {
    expect(parseLookupRequest('Here is your answer about chapter 3.')).toBeNull()
  })

  it('returns null when a real action tag is present — content beats lookup', () => {
    expect(parseLookupRequest('<lookup chapters="Chapter 2"></lookup>\n<canvas><p>New doc</p></canvas>')).toBeNull()
    expect(parseLookupRequest('<edit>\n<<<<<<< SEARCH\n<p>a</p>\n=======\n<p>b</p>\n>>>>>>> REPLACE\n</edit><lookup chapters="X"/>')).toBeNull()
  })

  it('returns null when substantial prose surrounds the tag', () => {
    const essay = 'word '.repeat(120)
    expect(parseLookupRequest(essay + '<lookup chapters="Chapter 2"/>')).toBeNull()
  })

  it('returns null for an empty or missing chapters attribute', () => {
    expect(parseLookupRequest('<lookup chapters=""></lookup>')).toBeNull()
    expect(parseLookupRequest('<lookup reason="hm"></lookup>')).toBeNull()
    expect(parseLookupRequest('<lookup chapters="; ;"></lookup>')).toBeNull()
  })

  it('trims quotes and whitespace from titles and defaults reason to empty', () => {
    const r = parseLookupRequest('<lookup chapters=" \'Chapter 5\' ;  Chapter 6  "></lookup>')
    expect(r?.titles).toEqual(['Chapter 5', 'Chapter 6'])
    expect(r?.reason).toBe('')
  })
})
