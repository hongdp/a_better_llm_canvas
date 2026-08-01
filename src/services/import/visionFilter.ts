/**
 * Vision API eligibility pre-filter for scraped images.
 * Extracted from ImportUrlModal.tsx (Phase 0 image analysis).
 */

import type { ScrapedData } from '../../types/import'

// Filter images suitable for vision API
const VISION_SAFE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg']

/**
 * Quick MIME and length filter: flag images the vision API cannot accept
 * (unsupported format or near-empty payload) as `failedAnalysis` immediately,
 * replacing their alt text with an explanatory placeholder. Returns a new
 * array; unaffected entries are passed through unchanged.
 */
export const flagUnsupportedVisionImages = (
  images: ScrapedData['images']
): ScrapedData['images'] => {
  const updatedImages = [...images]

  for (let i = 0; i < updatedImages.length; i++) {
    const img = updatedImages[i]
    const mimeMatch = img.base64.match(/^data:([^;]+);/i)
    const mimeType = mimeMatch ? mimeMatch[1].toLowerCase() : ''
    const isSafeType = VISION_SAFE_TYPES.includes(mimeType)
    const isLargeEnough = img.base64.length >= 1000

    if (!isSafeType || !isLargeEnough) {
      updatedImages[i] = {
        ...img,
        alt: !isSafeType
          ? '（配图格式不支持，已忽略分析）'
          : '（配图数据过小，已忽略分析）',
        failedAnalysis: true
      }
    }
  }

  return updatedImages
}
