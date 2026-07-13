/**
 * Content building utilities for the import pipeline.
 * Handles interleaving text/images, censoring, JSON extraction, and image placeholder replacement.
 */
import type { ScrapedData, ChapterPlan, GeneratedChapter } from '../../types/import'

/**
 * Determine if an error was caused by LLM safety guidelines / filters.
 */
export const isSafetyError = (err: unknown): boolean => {
  const message = typeof err === 'object' && err !== null && 'message' in err
    ? (err as { message?: unknown }).message
    : undefined
  const msg = String(message || err).toLowerCase()
  return (
    msg.includes('403') ||
    msg.includes('csam') ||
    msg.includes('safety') ||
    msg.includes('guidelines') ||
    msg.includes('block') ||
    msg.includes('permission') ||
    msg.includes('violates')
  )
}

/**
 * Escape special characters in a word for safe RegExp usage.
 */
export const escapeRegExp = (str: string): string => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Censor explicit/sensitive keywords to bypass deterministic safety filters.
 */
export const censorSensitiveText = (text: string, words: string[]): string => {
  if (!words || words.length === 0) return text
  let censored = text
  for (const word of words) {
    if (!word) continue
    try {
      const escaped = escapeRegExp(word)
      const regex = new RegExp(escaped, 'g')
      censored = censored.replace(regex, '***')
    } catch (e) {
      console.error('Invalid regex pattern for word:', word, e)
    }
  }
  return censored
}

/**
 * Extract JSON from LLM output (handles markdown code blocks).
 */
export const extractJson = (text: string): string => {
  // Try to find JSON in markdown code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim()
  }
  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    return jsonMatch[0]
  }
  return text.trim()
}

/**
 * Build content with image descriptions embedded inline at their original positions.
 */
export const buildInterleavedContent = (data: ScrapedData): string => {
  const lines: string[] = []
  const imagesByPosition = new Map<number, typeof data.images>()

  // Group images by their position (after which paragraph they appear)
  for (const img of data.images) {
    const pos = img.position
    if (!imagesByPosition.has(pos)) {
      imagesByPosition.set(pos, [])
    }
    imagesByPosition.get(pos)!.push(img)
  }

  // Images that appear before any paragraph (position 0)
  const leadingImages = imagesByPosition.get(0)
  if (leadingImages) {
    for (const img of leadingImages) {
      lines.push(`[📷 图片描述 IMG-${img.index}]: ${img.alt || '（图片，无文字描述）'}`)
    }
  }

  // Interleave paragraphs and images
  for (const p of data.paragraphs) {
    lines.push(`[P${p.index + 1}] ${p.text}`)
    // Check if any images appear after this paragraph
    const imagesAfter = imagesByPosition.get(p.index + 1)
    if (imagesAfter) {
      for (const img of imagesAfter) {
        lines.push(`[📷 图片描述 IMG-${img.index}]: ${img.alt || '（图片，无文字描述）'}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Build interleaved content for a specific chapter (paragraph range).
 */
export const buildChapterInterleavedContent = (
  data: ScrapedData,
  paragraphRange: [number, number]
): string => {
  const lines: string[] = []
  const imagesByPosition = new Map<number, typeof data.images>()

  // Group images by their position
  for (const img of data.images) {
    const pos = img.position
    if (!imagesByPosition.has(pos)) {
      imagesByPosition.set(pos, [])
    }
    imagesByPosition.get(pos)!.push(img)
  }

  const [startP, endP] = paragraphRange

  // If startP is 1 (or less), check if there are leading images (position 0)
  if (startP <= 1) {
    const leadingImages = imagesByPosition.get(0)
    if (leadingImages) {
      for (const img of leadingImages) {
        lines.push(`[📷 图片描述 IMG-${img.index}]: ${img.alt || '（图片，无文字描述）'}`)
      }
    }
  }

  // Interleave paragraphs and images in range
  for (const p of data.paragraphs) {
    const pNum = p.index + 1
    if (pNum >= startP && pNum <= endP) {
      lines.push(`[P${pNum}] ${p.text}`)
      const imagesAfter = imagesByPosition.get(pNum)
      if (imagesAfter) {
        for (const img of imagesAfter) {
          lines.push(`[📷 图片描述 IMG-${img.index}]: ${img.alt || '（图片，无文字描述）'}`)
        }
      }
    }
  }

  return lines.join('\n')
}

/**
 * Get the ending text of the previous chapter for transition context.
 */
export const getPreviousChapterEnding = (prevCh: GeneratedChapter | undefined): string => {
  if (!prevCh) return '（无，当前是第一章，请直接开始故事的开头）'
  try {
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = prevCh.content
    const plainText = tempDiv.textContent || tempDiv.innerText || ''
    const endingLength = 600
    if (plainText.length <= endingLength) return plainText
    return '...' + plainText.substring(plainText.length - endingLength)
  } catch {
    const endingLength = 600
    if (prevCh.content.length <= endingLength) return prevCh.content
    return '...' + prevCh.content.substring(prevCh.content.length - endingLength)
  }
}

/**
 * Replace {{IMG-N}} placeholders with actual <img> tags.
 */
export const replaceImagePlaceholders = (content: string, images: ScrapedData['images']): string => {
  return content.replace(/\{\{IMG-(\d+)\}\}/g, (_placeholder, indexStr) => {
    const idx = parseInt(indexStr, 10)
    const img = images.find(i => i.index === idx)
    if (img && img.base64) {
      // Use textContent-safe alt text by escaping HTML entities
      const safeAlt = (img.alt || '配图').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      return `<img src="${img.base64}" alt="${safeAlt}" style="max-width:100%;border-radius:8px;margin:1rem 0;display:block;" />`
    }
    return '' // Remove placeholder if image not found
  })
}

/**
 * Compile HTML for the outline page and return the structured documents ready for import.
 */
export const buildOutlineAndChapterDocs = (
  enrichedData: ScrapedData,
  plan: ChapterPlan,
  chapters: GeneratedChapter[],
  partial = false
): { title: string; content: string }[] => {
  const finishedImages = enrichedData.images || []
  const novelDocs = chapters.map(ch => {
    const processedContent = replaceImagePlaceholders(ch.content, finishedImages)
    return {
      title: ch.title,
      content: processedContent
    }
  })

  const outlineHtmlParts = [
    `<h1>${plan.bookTitle} — 全文大纲${partial ? ' (部分生成)' : ''}</h1>`,
    `<p><em>${plan.summary}</em></p>`,
    `<hr />`
  ]

  plan.chapters.forEach(ch => {
    const isGenerated = chapters.some(g => g.chapterNumber === ch.chapterNumber)
    const chLines = [
      `<h2>${ch.title}${partial ? (isGenerated ? '（已生成）' : '（未生成）') : ''}</h2>`,
      `<p>${ch.description}</p>`,
      `<p><strong>情感基调：</strong>${ch.mood} | <strong>段落范围：</strong>P${ch.paragraphRange[0]}–P${ch.paragraphRange[1]}</p>`
    ]

    if (ch.imageIndices && ch.imageIndices.length > 0) {
      const imgDescs: string[] = []
      for (const idx of ch.imageIndices) {
        const img = finishedImages.find(i => i.index === idx)
        if (img) {
          imgDescs.push(`<li><strong>IMG-${idx}</strong>: ${img.alt || '无描述'}</li>`)
        }
      }
      if (imgDescs.length > 0) {
        chLines.push(`<p><strong>本章配图及描述：</strong></p>`)
        chLines.push(`<ul>${imgDescs.join('')}</ul>`)
      }
    }
    outlineHtmlParts.push(chLines.join('\n'))
  })

  if (finishedImages.length > 0) {
    outlineHtmlParts.push(`<hr />`)
    outlineHtmlParts.push(`<h2>📷 全文配图描述汇总</h2>`)

    const galleryItems = finishedImages.map(img => {
      return `
        <div style="display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; padding: 8px; background-color: var(--bg-tertiary, #f8f9fa); border-radius: 6px;">
          <img src="${img.base64}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 4px; border: 1px solid var(--border-color, #e2e8f0); flex-shrink: 0;" />
          <div style="font-size: 0.9rem; line-height: 1.4;">
            <span style="color: var(--accent, #3b82f6); font-weight: 600;">IMG-${img.index}</span>: 
            <span>${img.alt || '（无文字描述）'}</span>
          </div>
        </div>
      `
    })
    outlineHtmlParts.push(galleryItems.join('\n'))
  }

  const outlineDoc = {
    title: partial ? '大纲 (部分生成)' : '大纲',
    content: outlineHtmlParts.join('\n')
  }

  return [outlineDoc, ...novelDocs]
}
