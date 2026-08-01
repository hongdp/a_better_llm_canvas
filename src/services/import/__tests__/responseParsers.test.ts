import { describe, it, expect } from 'vitest'
import {
  parseChapterPlanResponse,
  parseGeneratedChapterResponse,
  parseImageDescriptionsResponse
} from '../responseParsers'
import { flagUnsupportedVisionImages } from '../visionFilter'
import { buildPhase1Prompts, buildNextChapterOutline } from '../prompts'
import type { ScrapedData } from '../../../types/import'

// ── parseChapterPlanResponse ──────────────────────────────────────────────────
describe('parseChapterPlanResponse', () => {
  it('parses a valid plan and normalizes prefixed indices', () => {
    const llmOutput = `\`\`\`json
{
  "bookTitle": "Test Book",
  "summary": "A story.",
  "chapters": [
    {
      "chapterNumber": 1,
      "title": "Chapter One",
      "description": "Opening",
      "paragraphRange": [P1, P5],
      "imageIndices": [IMG-0, IMG-2],
      "mood": "calm"
    }
  ]
}
\`\`\``
    const plan = parseChapterPlanResponse(llmOutput)
    expect(plan.bookTitle).toBe('Test Book')
    expect(plan.chapters).toHaveLength(1)
    expect(plan.chapters[0].paragraphRange).toEqual([1, 5])
    expect(plan.chapters[0].imageIndices).toEqual([0, 2])
  })

  it('throws a descriptive error with { cause } on invalid output', () => {
    expect(() => parseChapterPlanResponse('not json at all')).toThrowError(/解析章节规划失败/)
    try {
      parseChapterPlanResponse('not json at all')
    } catch (e) {
      expect((e as Error).cause).toBeDefined()
    }
  })

  it('rejects plans without chapters', () => {
    expect(() => parseChapterPlanResponse('{"bookTitle": "x", "chapters": []}')).toThrowError(/解析章节规划失败/)
  })
})

// ── parseGeneratedChapterResponse ─────────────────────────────────────────────
describe('parseGeneratedChapterResponse', () => {
  it('parses a valid chapter object', () => {
    const ch = parseGeneratedChapterResponse('{"chapterNumber": 2, "title": "T", "content": "<h1>T</h1>"}', 2)
    expect(ch.title).toBe('T')
    expect(ch.content).toBe('<h1>T</h1>')
  })

  it('throws with chapter number when title/content missing', () => {
    expect(() => parseGeneratedChapterResponse('{"chapterNumber": 3}', 3)).toThrowError(/解析第 3 章失败/)
  })
})

// ── parseImageDescriptionsResponse ────────────────────────────────────────────
describe('parseImageDescriptionsResponse', () => {
  it('parses a JSON descriptions payload', () => {
    const descs = parseImageDescriptionsResponse('{"descriptions": [{"index": 1, "description": "a cat"}]}')
    expect(descs).toEqual([{ index: 1, description: 'a cat' }])
  })

  it('falls back to line parsing when JSON is invalid', () => {
    const descs = parseImageDescriptionsResponse('IMG-4: a dog in the park')
    expect(descs).toEqual([{ index: 4, description: 'a dog in the park' }])
  })

  it('throws when nothing can be parsed', () => {
    expect(() => parseImageDescriptionsResponse('???')).toThrowError(/无法解析/)
  })
})

// ── flagUnsupportedVisionImages ───────────────────────────────────────────────
describe('flagUnsupportedVisionImages', () => {
  it('flags unsupported formats and tiny payloads, passes valid images through', () => {
    const jpeg = `data:image/jpeg;base64,${'a'.repeat(1200)}`
    const images: ScrapedData['images'] = [
      { index: 0, alt: 'ok', base64: jpeg, position: 0 },
      { index: 1, alt: 'gif', base64: `data:image/gif;base64,${'a'.repeat(1200)}`, position: 1 },
      { index: 2, alt: 'small', base64: 'data:image/png;base64,aaa', position: 2 }
    ]
    const flagged = flagUnsupportedVisionImages(images)
    expect(flagged[0]).toBe(images[0])
    expect(flagged[1].failedAnalysis).toBe(true)
    expect(flagged[1].alt).toBe('（配图格式不支持，已忽略分析）')
    expect(flagged[2].failedAnalysis).toBe(true)
    expect(flagged[2].alt).toBe('（配图数据过小，已忽略分析）')
  })
})

// ── prompt builders (smoke) ───────────────────────────────────────────────────
describe('prompt builders', () => {
  const data: ScrapedData = {
    title: 'Page Title',
    paragraphs: [{ index: 1, text: 'hello', tag: 'p' }],
    images: [],
    totalParagraphs: 1,
    totalImages: 0
  }

  it('buildPhase1Prompts produces a system/user pair referencing the source data', () => {
    const { systemPrompt, userPrompt } = buildPhase1Prompts({
      data,
      interleavedContent: '[P1] hello',
      userCustomPrompt: '',
      censored: false
    })
    expect(systemPrompt.role).toBe('system')
    expect(userPrompt.role).toBe('user')
    expect(userPrompt.content).toContain('Page Title')
    expect(userPrompt.content).toContain('[P1] hello')
  })

  it('buildNextChapterOutline handles the last chapter', () => {
    expect(buildNextChapterOutline(undefined)).toBe('（已是最后一章，无后续章节）')
  })
})
