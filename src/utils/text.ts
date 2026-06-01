/**
 * Text utility functions.
 * Pure helpers for text processing — no React dependencies.
 */

/**
 * Generate a timestamp-based unique ID with the given prefix.
 */
export function getTimestampId(prefix: string): string {
  return `${prefix}-${Date.now()}`
}

/**
 * Strip an incomplete `</selection_replace>` suffix from streamed LLM text.
 * This handles the case where the stream is interrupted mid-tag.
 */
export function stripIncompleteEndTag(text: string): string {
  const target = '</selection_replace>'
  for (let i = target.length; i > 0; i--) {
    const prefix = target.substring(0, i)
    if (text.endsWith(prefix)) {
      return text.substring(0, text.length - prefix.length)
    }
  }
  return text
}

/**
 * Clean up LLM-generated HTML:
 * 1. Remove blank `<p>` tags that contain only whitespace or &nbsp;.
 * 2. Collapse whitespace (including newlines) between block-level tags
 *    so that `</p>\n<p>` doesn't produce an extra blank line in TipTap.
 */
export function stripBlankParagraphs(html: string): string {
  return html
    .replace(/<p>\s*(<br\s*\/?>)?\s*<\/p>/gi, '')
    .replace(/<p>(\s|&nbsp;)+<\/p>/gi, '')
    .replace(/(<\/(p|h[1-6]|blockquote|ul|ol|li|div)>)\s+(<(p|h[1-6]|blockquote|ul|ol|li|div)[\s>])/gi, '$1$3')
}

/**
 * Count words in HTML content.
 * Handles CJK (Chinese/Japanese/Korean) characters as individual words,
 * and uses Unicode-aware word boundaries for Latin text.
 * Strips `<del>` content (deleted diff text) before counting.
 */
export function countWords(html: string): number {
  if (!html) return 0
  
  // 1. Remove <del>...</del> tags and their contents (deleted text from diffs)
  let cleanText = html.replace(/<del\b[^>]*>([\s\S]*?)<\/del>/gi, '')
  
  // 2. Replace all other HTML tags with spaces
  cleanText = cleanText.replace(/<[^>]*>/g, ' ')
  
  // 3. Replace &nbsp; and other whitespace entities with standard spaces
  cleanText = cleanText.replace(/&nbsp;/g, ' ')
  
  // 4. Decode common HTML entities to avoid counting them as words
  cleanText = cleanText
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")

  // Match CJK characters (Chinese, Japanese, Korean)
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g
  const cjkCount = (cleanText.match(cjkRegex) || []).length
  
  // Remove CJK characters to count other words (Latin, Cyrillic, Arabic, etc.)
  const nonCjkText = cleanText.replace(cjkRegex, ' ')
  
  // Match words using unicode property escapes: letters and numbers, optionally with internal apostrophe/hyphen
  const wordRegex = /[\p{L}\p{N}]+(?:[''‑][\p{L}\p{N}]+)*/gu
  const otherCount = (nonCjkText.match(wordRegex) || []).length
  
  return cjkCount + otherCount
}

/**
 * Convert a blob: URL to a data: URL via fetch + FileReader.
 */
export const convertBlobUrlToDataUrl = async (blobUrl: string): Promise<string> => {
  try {
    const res = await fetch(blobUrl)
    const blob = await res.blob()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch (err) {
    console.error('Failed to convert blob URL to data URL:', err)
    return blobUrl
  }
}

/**
 * Convert a GIF data URL to JPEG by drawing the first frame on a canvas.
 * Returns the original URL unchanged if it's not a GIF.
 */
export const convertGifToJpegIfNeeded = (dataUrl: string): Promise<string> => {
  if (!dataUrl.startsWith('data:image/gif')) {
    return Promise.resolve(dataUrl)
  }
  return new Promise<string>((resolve) => {
    const img = new window.Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || img.width
        canvas.height = img.naturalHeight || img.height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(dataUrl)
          return
        }
        ctx.drawImage(img, 0, 0)
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9)
        resolve(jpegDataUrl)
      } catch (err) {
        console.error('Error drawing GIF to canvas:', err)
        resolve(dataUrl)
      }
    }
    img.onerror = () => {
      console.error('Error loading GIF image')
      resolve(dataUrl)
    }
    img.src = dataUrl
  })
}
