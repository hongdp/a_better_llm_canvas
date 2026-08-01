/**
 * Parsers for LLM responses in the URL/HTML import pipeline.
 * Extracted from ImportUrlModal.tsx. Each parser throws a descriptive
 * Error (with the original failure attached as { cause }) when the LLM
 * output is unusable.
 */

import type { ChapterPlan, GeneratedChapter } from '../../types/import'
import { extractJson } from './contentBuilder'
import { errorMessage } from './errors'

export interface ImageDescription {
  index: number | string
  description: string
}

/**
 * Parse a Phase 1 chapter-plan response, tolerating prefixed indices
 * (e.g. [P11, P35] or [IMG-0]) which some models emit despite instructions.
 */
export const parseChapterPlanResponse = (fullText: string): ChapterPlan => {
  try {
    let jsonStr = extractJson(fullText)

    // 1. Fix unquoted prefixes in arrays (e.g. [P11, P35] -> [11, 35], [IMG-0, IMG-1] -> [0, 1])
    // to prevent JSON.parse syntax errors.
    jsonStr = jsonStr.replace(/\[\s*([\s\S]*?)\s*\]/g, (arrayMatch) => {
      return arrayMatch.replace(/[A-Za-z]+-?(\d+)/g, '$1')
    })

    const plan = JSON.parse(jsonStr) as ChapterPlan

    // 2. Post-parse normalization to convert any stringified or prefixed indices to pure numbers
    if (plan.chapters && Array.isArray(plan.chapters)) {
      plan.chapters.forEach(ch => {
        if (ch.paragraphRange) {
          ch.paragraphRange = [
            parseInt(String(ch.paragraphRange[0]).replace(/\D/g, ''), 10) || 0,
            parseInt(String(ch.paragraphRange[1]).replace(/\D/g, ''), 10) || 0
          ]
        }
        if (ch.imageIndices) {
          ch.imageIndices = ch.imageIndices
            .map(idx => parseInt(String(idx).replace(/\D/g, ''), 10))
            .filter(idx => !isNaN(idx))
        }
      })
    }

    if (!plan.chapters || !Array.isArray(plan.chapters) || plan.chapters.length === 0) {
      throw new Error('LLM 返回的章节规划格式无效')
    }
    return plan
  } catch (e) {
    throw new Error(`解析章节规划失败: ${errorMessage(e)}. LLM输出: ${fullText.substring(0, 200)}...`, { cause: e })
  }
}

/**
 * Parse a Phase 2 generated-chapter response.
 */
export const parseGeneratedChapterResponse = (fullText: string, chapterNumber: number): GeneratedChapter => {
  try {
    const jsonStr = extractJson(fullText)
    const chObj = JSON.parse(jsonStr) as GeneratedChapter
    if (!chObj.content || !chObj.title) {
      throw new Error('JSON 中缺少 title 或 content 字段')
    }
    return chObj
  } catch (e) {
    throw new Error(`解析第 ${chapterNumber} 章失败: ${errorMessage(e)}. LLM 输出: ${fullText.substring(0, 200)}`, { cause: e })
  }
}

/**
 * Parse a Phase 0 image-analysis response. Prefers the JSON `descriptions`
 * payload; falls back to line-by-line "IMG-N: description" parsing when the
 * model did not return valid JSON.
 */
export const parseImageDescriptionsResponse = (fullText: string): ImageDescription[] => {
  let descs: unknown
  try {
    const jsonStr = extractJson(fullText)
    const result = JSON.parse(jsonStr)
    descs = result.descriptions || result
  } catch {
    console.warn('[Image Analysis] Failed to parse JSON, using fallback parser')
    const fallbackDescs: ImageDescription[] = []
    const lines = fullText.split('\n')
    for (const line of lines) {
      const match = line.match(/(?:IMG-)?(\d+)\s*[:：\-—\s]\s*(.+)/i)
      if (match) {
        fallbackDescs.push({
          index: parseInt(match[1], 10),
          description: match[2].trim()
        })
      }
    }
    if (fallbackDescs.length > 0) {
      return fallbackDescs
    }
    throw new Error('无法解析 LLM 的图片分析输出。')
  }

  if (Array.isArray(descs)) {
    return descs
  }
  throw new Error('LLM 返回的图片描述格式不正确。')
}
