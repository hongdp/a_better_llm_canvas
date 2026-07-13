import { describe, it, expect } from 'vitest'
import {
  isSafetyError,
  escapeRegExp,
  censorSensitiveText,
  extractJson,
  buildInterleavedContent,
  buildChapterInterleavedContent,
  getPreviousChapterEnding,
  replaceImagePlaceholders,
  buildOutlineAndChapterDocs
} from '../contentBuilder'
import type { ScrapedData, ChapterPlan, GeneratedChapter } from '../../../types/import'

// ── isSafetyError ─────────────────────────────────────────────────────────────
describe('isSafetyError', () => {
  it('detects "safety" keyword', () => {
    expect(isSafetyError(new Error('safety guidelines violated'))).toBe(true)
  })

  it('detects "block" keyword', () => {
    expect(isSafetyError(new Error('content was blocked'))).toBe(true)
  })

  it('detects "403" status code string', () => {
    expect(isSafetyError(new Error('HTTP 403 Forbidden'))).toBe(true)
  })

  it('detects "guidelines" keyword', () => {
    expect(isSafetyError(new Error('violates usage guidelines'))).toBe(true)
  })

  it('detects "violates" keyword', () => {
    expect(isSafetyError(new Error('this violates policy'))).toBe(true)
  })

  it('detects "permission" keyword', () => {
    expect(isSafetyError(new Error('no permission to do this'))).toBe(true)
  })

  it('returns false for a regular error', () => {
    expect(isSafetyError(new Error('network timeout'))).toBe(false)
  })

  it('returns false for an empty error', () => {
    expect(isSafetyError(new Error(''))).toBe(false)
  })

  it('is case-insensitive (uppercase keyword)', () => {
    expect(isSafetyError(new Error('SAFETY CHECK FAILED'))).toBe(true)
  })
})

// ── escapeRegExp ──────────────────────────────────────────────────────────────
describe('escapeRegExp', () => {
  it('escapes dot', () => {
    expect(escapeRegExp('.')).toBe('\\.')
  })

  it('escapes asterisk', () => {
    expect(escapeRegExp('*')).toBe('\\*')
  })

  it('escapes parentheses', () => {
    expect(escapeRegExp('(hello)')).toBe('\\(hello\\)')
  })

  it('passes through alphanumeric strings unchanged', () => {
    expect(escapeRegExp('hello123')).toBe('hello123')
  })

  it('escapes all special regex characters', () => {
    const special = '.+?*^${}()|[]\\/'
    const escaped = escapeRegExp(special)
    // Should be usable in a RegExp without throwing
    expect(() => new RegExp(escaped)).not.toThrow()
  })
})

// ── censorSensitiveText ───────────────────────────────────────────────────────
describe('censorSensitiveText', () => {
  it('replaces a single word with ***', () => {
    expect(censorSensitiveText('hello world', ['world'])).toBe('hello ***')
  })

  it('replaces multiple occurrences of the same word', () => {
    expect(censorSensitiveText('bad bad bad', ['bad'])).toBe('*** *** ***')
  })

  it('replaces multiple different words', () => {
    const result = censorSensitiveText('foo and bar', ['foo', 'bar'])
    expect(result).toBe('*** and ***')
  })

  it('returns text unchanged when word list is empty', () => {
    expect(censorSensitiveText('hello world', [])).toBe('hello world')
  })

  it('handles regex-special characters in words gracefully', () => {
    // "c++" contains a special char; should not throw
    expect(() => censorSensitiveText('I love c++', ['c++'])).not.toThrow()
    expect(censorSensitiveText('I love c++', ['c++'])).toBe('I love ***')
  })

  it('handles empty text', () => {
    expect(censorSensitiveText('', ['word'])).toBe('')
  })

  it('skips null/empty words in the list', () => {
    expect(censorSensitiveText('hello world', ['', 'world'])).toBe('hello ***')
  })
})

// ── extractJson ───────────────────────────────────────────────────────────────
describe('extractJson', () => {
  it('extracts JSON from a markdown ```json code block', () => {
    const input = '```json\n{"key": "value"}\n```'
    expect(extractJson(input)).toBe('{"key": "value"}')
  })

  it('extracts JSON from a plain ``` code block', () => {
    const input = '```\n{"key": "value"}\n```'
    expect(extractJson(input)).toBe('{"key": "value"}')
  })

  it('extracts a raw JSON object from text with surrounding prose', () => {
    const input = 'Here is the result: {"result": 42} done.'
    expect(extractJson(input)).toBe('{"result": 42}')
  })

  it('returns the trimmed input when no JSON is detected', () => {
    expect(extractJson('  no json here  ')).toBe('no json here')
  })

  it('handles nested JSON objects', () => {
    const input = '{"outer": {"inner": 1}}'
    expect(extractJson(input)).toBe(input)
  })

  it('prefers code block extraction over raw JSON match', () => {
    const input = '```json\n{"from_block": true}\n```\n{"from_raw": true}'
    const result = extractJson(input)
    expect(result).toContain('from_block')
  })
})

// ── buildInterleavedContent ───────────────────────────────────────────────────
describe('buildInterleavedContent', () => {
  const makeData = (
    paragraphs: { index: number; text: string }[],
    images: { index: number; alt: string; position: number; base64: string }[] = []
  ): ScrapedData => ({
    title: 'Test',
    paragraphs: paragraphs.map(p => ({ ...p, tag: 'p' })),
    images: images.map(img => ({ ...img, failedAnalysis: false })),
    totalParagraphs: paragraphs.length,
    totalImages: images.length
  })

  it('numbers paragraphs as [P1], [P2], etc.', () => {
    const data = makeData([{ index: 0, text: 'First' }, { index: 1, text: 'Second' }])
    const result = buildInterleavedContent(data)
    expect(result).toContain('[P1] First')
    expect(result).toContain('[P2] Second')
  })

  it('includes leading images (position 0) before paragraphs', () => {
    const data = makeData(
      [{ index: 0, text: 'Para' }],
      [{ index: 0, alt: 'cover image', position: 0, base64: 'data:image/png;base64,abc' }]
    )
    const lines = buildInterleavedContent(data).split('\n')
    expect(lines[0]).toContain('IMG-0')
    expect(lines[1]).toContain('[P1]')
  })

  it('interleaves images after the correct paragraph', () => {
    const data = makeData(
      [{ index: 0, text: 'First' }, { index: 1, text: 'Second' }],
      [{ index: 0, alt: 'fig', position: 1, base64: 'data:image/png;base64,abc' }]
    )
    const content = buildInterleavedContent(data)
    const lines = content.split('\n')
    const p1Idx = lines.findIndex(l => l.includes('[P1]'))
    const imgIdx = lines.findIndex(l => l.includes('IMG-0'))
    expect(imgIdx).toBeGreaterThan(p1Idx)
  })

  it('handles data with no images', () => {
    const data = makeData([{ index: 0, text: 'Only text' }])
    const result = buildInterleavedContent(data)
    expect(result).toBe('[P1] Only text')
  })

  it('uses fallback alt text for images without description', () => {
    const data = makeData(
      [{ index: 0, text: 'Para' }],
      [{ index: 0, alt: '', position: 0, base64: 'data:image/png;base64,abc' }]
    )
    const result = buildInterleavedContent(data)
    expect(result).toContain('无文字描述')
  })
})

// ── buildChapterInterleavedContent ────────────────────────────────────────────
describe('buildChapterInterleavedContent', () => {
  const makeData = (
    count: number,
    images: { index: number; alt: string; position: number; base64: string }[] = []
  ): ScrapedData => ({
    title: 'Test',
    paragraphs: Array.from({ length: count }, (_, i) => ({ index: i, text: `Para ${i + 1}`, tag: 'p' })),
    images: images.map(img => ({ ...img, failedAnalysis: false })),
    totalParagraphs: count,
    totalImages: images.length
  })

  it('only includes paragraphs within the specified range', () => {
    const data = makeData(5)
    const result = buildChapterInterleavedContent(data, [2, 3])
    expect(result).not.toContain('[P1]')
    expect(result).toContain('[P2]')
    expect(result).toContain('[P3]')
    expect(result).not.toContain('[P4]')
  })

  it('includes leading images when range starts at 1', () => {
    const data = makeData(
      3,
      [{ index: 0, alt: 'cover', position: 0, base64: 'data:image/png;base64,abc' }]
    )
    const result = buildChapterInterleavedContent(data, [1, 2])
    expect(result).toContain('IMG-0')
  })

  it('does NOT include leading images when range starts after 1', () => {
    const data = makeData(
      3,
      [{ index: 0, alt: 'cover', position: 0, base64: 'data:image/png;base64,abc' }]
    )
    const result = buildChapterInterleavedContent(data, [2, 3])
    expect(result).not.toContain('IMG-0')
  })

  it('returns empty string for an empty paragraph list', () => {
    const data = makeData(0)
    expect(buildChapterInterleavedContent(data, [1, 5])).toBe('')
  })
})

// ── getPreviousChapterEnding ──────────────────────────────────────────────────
describe('getPreviousChapterEnding', () => {
  it('returns the first-chapter fallback message when undefined', () => {
    expect(getPreviousChapterEnding(undefined)).toContain('第一章')
  })

  it('returns the full plain text for short content', () => {
    const ch: GeneratedChapter = {
      chapterNumber: 1,
      title: 'Ch 1',
      content: '<p>Short ending.</p>'
    }
    const result = getPreviousChapterEnding(ch)
    expect(result).toContain('Short ending')
  })

  it('truncates long content and prepends "..."', () => {
    const longText = 'x'.repeat(700)
    const ch: GeneratedChapter = {
      chapterNumber: 1,
      title: 'Ch 1',
      content: `<p>${longText}</p>`
    }
    const result = getPreviousChapterEnding(ch)
    expect(result.startsWith('...')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(603) // 600 + "..."
  })
})

// ── replaceImagePlaceholders ──────────────────────────────────────────────────
describe('replaceImagePlaceholders', () => {
  const makeImages = (overrides: Partial<ScrapedData['images'][0]>[] = []): ScrapedData['images'] =>
    overrides.map((o, i) => ({
      index: i,
      alt: 'image',
      base64: 'data:image/png;base64,abc',
      position: 0,
      failedAnalysis: false,
      ...o
    }))

  it('replaces {{IMG-0}} with an <img> tag', () => {
    const content = '<p>{{IMG-0}}</p>'
    const result = replaceImagePlaceholders(content, makeImages([{ index: 0 }]))
    expect(result).toContain('<img')
    expect(result).not.toContain('{{IMG-0}}')
  })

  it('replaces multiple different placeholders', () => {
    const content = '{{IMG-0}} and {{IMG-1}}'
    const images = makeImages([{ index: 0 }, { index: 1 }])
    const result = replaceImagePlaceholders(content, images)
    expect(result).not.toContain('{{IMG-0}}')
    expect(result).not.toContain('{{IMG-1}}')
  })

  it('removes a placeholder when the image is not in the list', () => {
    const content = '{{IMG-99}}'
    const result = replaceImagePlaceholders(content, makeImages([{ index: 0 }]))
    expect(result).toBe('')
  })

  it('removes a placeholder when the image has no base64 data', () => {
    const content = '{{IMG-0}}'
    const images = makeImages([{ index: 0, base64: '' }])
    const result = replaceImagePlaceholders(content, images)
    expect(result).toBe('')
  })

  it('escapes HTML entities in the alt text to prevent XSS', () => {
    const content = '{{IMG-0}}'
    const images = makeImages([{ index: 0, alt: '<script>xss</script>' }])
    const result = replaceImagePlaceholders(content, images)
    expect(result).not.toContain('<script>')
    expect(result).toContain('&lt;script&gt;')
  })
})

// ── buildOutlineAndChapterDocs ────────────────────────────────────────────────
describe('buildOutlineAndChapterDocs', () => {
  const makeScrapedData = (): ScrapedData => ({
    title: 'My Story',
    paragraphs: [],
    images: [],
    totalParagraphs: 0,
    totalImages: 0
  })

  const makePlan = (): ChapterPlan => ({
    bookTitle: 'Great Book',
    summary: 'A great summary.',
    chapters: [
      {
        chapterNumber: 1,
        title: 'Chapter One',
        description: 'The first chapter',
        paragraphRange: [1, 10],
        imageIndices: [],
        mood: 'hopeful'
      }
    ]
  })

  const makeChapters = (): GeneratedChapter[] => [
    { chapterNumber: 1, title: 'Chapter One', content: '<p>Story content here</p>' }
  ]

  it('returns outline as first document', () => {
    const docs = buildOutlineAndChapterDocs(makeScrapedData(), makePlan(), makeChapters())
    expect(docs[0].title).toBe('大纲')
  })

  it('returns chapter docs after the outline', () => {
    const docs = buildOutlineAndChapterDocs(makeScrapedData(), makePlan(), makeChapters())
    expect(docs).toHaveLength(2) // outline + 1 chapter
    expect(docs[1].title).toBe('Chapter One')
  })

  it('marks outline as partial when partial=true', () => {
    const docs = buildOutlineAndChapterDocs(makeScrapedData(), makePlan(), makeChapters(), true)
    expect(docs[0].title).toContain('部分生成')
  })

  it('includes book title in outline HTML', () => {
    const docs = buildOutlineAndChapterDocs(makeScrapedData(), makePlan(), makeChapters())
    expect(docs[0].content).toContain('Great Book')
  })

  it('includes summary in outline HTML', () => {
    const docs = buildOutlineAndChapterDocs(makeScrapedData(), makePlan(), makeChapters())
    expect(docs[0].content).toContain('A great summary.')
  })

  it('marks ungenerated chapters as "未生成" when partial=true', () => {
    const plan = makePlan()
    plan.chapters.push({
      chapterNumber: 2,
      title: 'Chapter Two',
      description: 'desc',
      paragraphRange: [11, 20],
      imageIndices: [],
      mood: 'sad'
    })
    // Only chapter 1 generated
    const docs = buildOutlineAndChapterDocs(makeScrapedData(), plan, makeChapters(), true)
    expect(docs[0].content).toContain('未生成')
  })

  it('replaces {{IMG-N}} placeholders in chapter content', () => {
    const data = makeScrapedData()
    data.images = [{ index: 0, alt: 'fig', base64: 'data:image/png;base64,abc', position: 0, failedAnalysis: false }]
    const chapters: GeneratedChapter[] = [{
      chapterNumber: 1, title: 'Ch1', content: '<p>{{IMG-0}}</p>'
    }]
    const docs = buildOutlineAndChapterDocs(data, makePlan(), chapters)
    expect(docs[1].content).toContain('<img')
    expect(docs[1].content).not.toContain('{{IMG-0}}')
  })
})
