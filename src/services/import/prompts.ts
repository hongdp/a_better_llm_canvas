/**
 * LLM prompt builders for the URL/HTML import pipeline (Phase 0/1/2).
 * Pure functions of the scraped data and plan — extracted from
 * ImportUrlModal.tsx. The prompt template strings move here verbatim.
 */

import type { LLMMessage } from '../../types/llm'
import type { ScrapedData, ChapterPlan } from '../../types/import'

type ChapterPlanItem = ChapterPlan['chapters'][number]

export interface PromptPair {
  systemPrompt: LLMMessage
  userPrompt: LLMMessage
}

/**
 * Build the Phase 1 (content analysis & chapter planning) prompt pair.
 * `data` is the original scraped data (titles/counts are always taken from
 * it), while `interleavedContent` may come from a censored copy.
 */
export const buildPhase1Prompts = (params: {
  data: ScrapedData
  interleavedContent: string
  userCustomPrompt: string
  censored: boolean
}): PromptPair => {
  const { data, interleavedContent, userCustomPrompt, censored } = params

  const systemPrompt: LLMMessage = {
    role: 'system',
    content: `你是一位专业的文学编辑和小说策划师。你的任务是分析提供的网页原始内容，理解其中的故事情节、人物、场景和情感线索，然后将其规划为一部小说的章节结构。

${userCustomPrompt ? `用户自定义写作指导：\n${userCustomPrompt}\n\n` : ''}注意：原文中的 [📷 图片描述 IMG-N] 标记表示该位置有一张配图，描述了图片的内容。请在规划章节时考虑这些图片的位置 and 内容。

任务要求：
1. 仔细阅读全部原文内容（包括图片描述）
2. 识别故事的主要情节线、场景转换、情感变化
3. 将内容划分为合适的章节（1-10章均可，章节数量应当根据原文长度和丰富度灵活决定。确保规划的每个章节包含足够的原始素材，以支撑后续生成和扩写到5000字左右的篇幅）
4. 为每个章节设计一个引人入胜的标题
5. 标注每个章节应该包含哪些原文段落（用段落编号范围标记）
6. 标注每个章节应该配哪些图片（用图片编号标记）

输出要求：
- 只输出一个合法的 JSON 对象，不要有任何其他文字
- JSON 结构严格按照下面的格式
- 注意：paragraphRange 必须是包含纯数字的数组（例如 [11, 35]），绝对不要带 'P' 前缀（绝对不要写成 [P11, P35]）
- 注意：imageIndices 必须是包含纯数字的数组（例如 [0, 1]），绝对不要带 'IMG-' 前缀（绝对不要写成 [IMG-0, IMG-1]）`
  }

  const userPrompt: LLMMessage = {
    role: 'user',
    content: `请分析以下网页内容并制定小说章节规划。

原始页面标题: ${data.title}

原文内容（段落与配图按原始顺序排列，共${data.totalParagraphs}段文字、${data.totalImages}张配图）:${censored ? '\n（注意：部分敏感词已被安全处理打码）' : ''}
---
${interleavedContent}
---

请输出以下 JSON 格式的章节规划：
{
  "bookTitle": "小说总标题",
  "summary": "全文故事概述（1-2句话）",
  "chapters": [
    {
      "chapterNumber": 1,
      "title": "第一章: 章节标题",
      "description": "本章内容概述",
      "paragraphRange": [1, 5],
      "imageIndices": [0, 1],
      "mood": "章节情感基调"
    }
  ]
}
特别注意：paragraphRange 与 imageIndices 数组中的元素必须是纯数字，绝对不可带有 'P' 或 'IMG-' 等非数字前缀字符！`
  }

  return { systemPrompt, userPrompt }
}

/**
 * Describe the next chapter's plan for the Phase 2 "结尾衔接" instruction.
 */
export const buildNextChapterOutline = (nextChPlan: ChapterPlanItem | undefined): string =>
  nextChPlan
    ? `下章标题: ${nextChPlan.title}\n下章内容概述: ${nextChPlan.description}\n下章段落范围: P${nextChPlan.paragraphRange[0]} 至 P${nextChPlan.paragraphRange[1]}`
    : '（已是最后一章，无后续章节）'

/**
 * Build the Phase 2 (novel chapter generation) prompt pair for one chapter.
 */
export const buildPhase2ChapterPrompts = (params: {
  plan: ChapterPlan
  chPlan: ChapterPlanItem
  userCustomPrompt: string
  prevEnding: string
  nextChapterOutline: string
  imageDescriptions: string
  interleavedContent: string
  imageBase64s: string[]
}): PromptPair => {
  const {
    plan, chPlan, userCustomPrompt, prevEnding, nextChapterOutline,
    imageDescriptions, interleavedContent, imageBase64s
  } = params

  // Generate dynamic examples based on the actual images in this chapter
  const hasImages = chPlan.imageIndices && chPlan.imageIndices.length > 0;
  const exampleIndex = hasImages ? chPlan.imageIndices[0] : 2;
  const exampleTag = `{{IMG-${exampleIndex}}}`;
  const exampleList = hasImages ? chPlan.imageIndices.map(i => `{{IMG-${i}}}`).join(' 和 ') : '{{IMG-2}} 等';

  const systemPrompt: LLMMessage = {
    role: 'system',
    content: `你是一位才华横溢的小说家。你的任务是根据提供的小说大纲、前文结尾、下一章大纲规划、当前章节规划和原始素材，创作当前章节的精彩小说内容。

${userCustomPrompt ? `用户自定义写作指导：\n${userCustomPrompt}\n\n` : ''}注意：原文中的 [📷 图片描述 IMG-XXX] 标记表示该位置有一张配图。请在改写时：
- 将图片描述的内容自然融入叙事（描写图片中展现的场景、环境氛围等）。
- 在图片应该出现的位置，严格使用纯数字的占位标记，例如 ${exampleTag}，前端会自动替换为实际图片。请注意占位符内的数字必须是对应图片的真实编号，绝对不能包含英文字母！

写作要求：
1. **严格限制写作范围**：当前章节**只允许**对本章对应的段落范围进行创作，绝对不能超出范围，严禁提前编写属于后续章节的情节，确保每个章节边界清晰。
2. 保持原文的核心情节和信息不变。
3. 用优美的文学语言改写，增加丰富的细节描写、心理活动 and 生动的对话。
4. **前后衔接有序**：
   - **开头衔接**：请仔细阅读提供的“前文结尾”，保证本章的开头能与其无缝、流畅地衔接。**强烈强调：输出的文字绝对不要与“前文结尾”的内容有任何重复，必须紧接着前文的情节继续往后写。**
   - **结尾衔接**：请仔细阅读提供的“下章大纲规划”，保证本章的结尾能够自然地向下一章过渡，建立有序的承接关系。
5. **文章篇幅控制**：确保整章写作的字数达到5000字左右。你应该通过补充生动的对话、丰富的环境细节描写、细致的角色动作以及深刻的内心独白来进行文学扩写，使篇幅显著充实，严禁敷衍或字数不足，同时也要避免无意义的重复注水。
6. 使用与原文相同的语言。

输出格式要求：
- 只输出一个合法的 JSON 对象，不要有任何其他文字。
- 使用 HTML 格式（p, em, strong 等标签），并以 <h1>当前章节标题</h1> 作为开头。
- 在图片应该出现的位置，严格使用带有具体数字的占位标记，例如 ${exampleTag}。绝对不能使用非数字字符。

JSON格式：
{
  "chapterNumber": ${chPlan.chapterNumber},
  "title": "${chPlan.title.replace(/"/g, '\\"')}",
  "content": "<h1>${chPlan.title.replace(/"/g, '\\"')}</h1><p>正文第一段...</p><p>${exampleTag}</p><p>正文第二段...</p>"
}`
  }

  const userPrompt: LLMMessage = {
    role: 'user',
    content: `请为我创作小说的第 ${chPlan.chapterNumber} 章。

【小说基本信息】
小说总标题: ${plan.bookTitle}
全文故事概述: ${plan.summary}

【前文结尾承接】
以下是前一章的结尾内容（请保证本章开头能够与之无缝衔接）：
---
${prevEnding}
---

【下章大纲规划】
以下是下一章的规划内容（请保证本章结尾能够自然向其过渡,但不要超越章节边界写出下一章的内容）：
---
${nextChapterOutline}
---

【本章写作规划】
本章标题: ${chPlan.title}
本章情感基调: ${chPlan.mood}
本章段落范围: P${chPlan.paragraphRange[0]} 至 P${chPlan.paragraphRange[1]} （特别提示：本章只能且必须只改写该段落范围内的原始素材，绝对不可写到超出该范围的后续情节！）
本章包含的配图编号: ${chPlan.imageIndices.length > 0 ? chPlan.imageIndices.map(index => `IMG-${index}`).join(', ') : '无'}

【本章相关配图描述】
${imageDescriptions}

【本章对应的原始素材（段落与配图）】
---
${interleavedContent}
---

请根据本章规划和素材，创作本章的完整小说正文（目标字数在5000字左右），输出合法的 JSON 格式。并在合适的位置插入对应的图片占位符（数字必须完全匹配，请使用类似 ${exampleList} 的格式）。`,
    images: imageBase64s
  }

  return { systemPrompt, userPrompt }
}

/**
 * Build the Phase 0 (vision image analysis) prompt pair for one image.
 * `imageAnalysisPrompt` is the user-configurable system prompt template with
 * a `{{index}}` placeholder.
 */
export const buildImageAnalysisPrompts = (
  img: ScrapedData['images'][number],
  imageAnalysisPrompt: string
): PromptPair => {
  const systemPrompt: LLMMessage = {
    role: 'system',
    content: imageAnalysisPrompt.replace('{{index}}', String(img.index))
  }

  const userPrompt: LLMMessage = {
    role: 'user',
    content: `请描述这张图片。图片编号为: IMG-${img.index}`,
    images: [img.base64]
  }

  return { systemPrompt, userPrompt }
}
