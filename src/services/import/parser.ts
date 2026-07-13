/**
 * Client-side HTML parsing for the import pipeline.
 * Parses raw HTML into structured ScrapedData with paragraphs and images.
 */
import type { ScrapedData } from '../../types/import'
import { fetchImageAsBase64 } from './imageProcessor'

/**
 * Parse raw HTML text into structured ScrapedData with paragraphs and images.
 * Used for client-side parsing of small files (< 5MB).
 */
export const parseHtmlToScrapedData = async (htmlText: string, filename: string): Promise<ScrapedData> => {
  const base64Images: string[] = []
  const placeholderPrefix = 'data:image/placeholder;base64,'

  // Pre-process HTML to strip huge inline base64 data URLs to prevent DOMParser OOM crashes
  const cleanedHtml = htmlText.replace(/(["'])(data:[^"']{100,})\1/g, (_, quote, dataUrl) => {
    if (dataUrl.toLowerCase().startsWith('data:image/')) {
      const index = base64Images.length
      base64Images.push(dataUrl)
      return `${quote}${placeholderPrefix}${index}${quote}`
    }
    return `${quote}data:null${quote}`
  })

  const parser = new DOMParser()
  const doc = parser.parseFromString(cleanedHtml, 'text/html')

  // 1. Extract Base URL
  let baseHref = ''
  const baseEl = doc.querySelector('base')
  if (baseEl && baseEl.getAttribute('href')) {
    baseHref = baseEl.getAttribute('href') || ''
  }

  // 2. Extract Title
  let title = ''
  const threadSubjectEl = doc.querySelector('#thread_subject')
  if (threadSubjectEl && threadSubjectEl.textContent) {
    title = threadSubjectEl.textContent.trim()
  } else {
    const titleEl = doc.querySelector('title')
    if (titleEl && titleEl.textContent) {
      title = titleEl.textContent.replace(/(_首发原创|_手机版|_论坛|_春满四合院|_春满四合院论坛).*$/, '').trim()
    }
  }
  if (!title) {
    title = filename.substring(0, filename.lastIndexOf('.')) || filename
  }

  // 3. Remove script, style, etc.
  const tagsToRemove = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript']
  tagsToRemove.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => el.remove())
  })

  const paragraphs: { index: number; text: string; tag: string }[] = []
  const tempImages: { alt: string; url: string; base64: string; position: number }[] = []

  let currentText = ''
  let currentTag = 'p'

  const commitParagraph = () => {
    const text = currentText.trim().replace(/\s+/g, ' ')
    if (text.length > 5) {
      if (paragraphs.length === 0 || paragraphs[paragraphs.length - 1].text !== text) {
        paragraphs.push({
          index: paragraphs.length,
          text,
          tag: currentTag
        })
      }
    }
    currentText = ''
  }

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      currentText += node.textContent || ''
    } else if (node.nodeType === 1) {
      const el = node as Element
      const tagName = el.tagName.toLowerCase()

      if (['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'iframe'].includes(tagName)) {
        return
      }

      if (tagName === 'img') {
        const attrs = [
          el.getAttribute('file'),
          el.getAttribute('data-src'),
          el.getAttribute('data-original'),
          el.getAttribute('data-lazy-src'),
          el.getAttribute('data-original-src'),
          el.getAttribute('src')
        ].map(v => (v || '').trim()).filter(Boolean)

        let src = attrs.find(attr => {
          if (!attr.startsWith('data:') && !attr.startsWith(placeholderPrefix)) return false
          const lower = attr.toLowerCase()
          if (lower.includes('image/svg+xml')) return false
          if (lower.includes('image/gif') && attr.length < 200) return false
          return true
        }) || ''

        if (!src) {
          src = (
            el.getAttribute('file') ||
            el.getAttribute('data-src') ||
            el.getAttribute('data-original') ||
            el.getAttribute('data-lazy-src') ||
            el.getAttribute('data-original-src') ||
            el.getAttribute('src') ||
            ''
          ).trim()
        }

        const alt = el.getAttribute('alt') || ''
        if (src) {
          let resolvedSrc = src
          if (src.startsWith(placeholderPrefix)) {
            const indexStr = src.substring(placeholderPrefix.length)
            const index = parseInt(indexStr, 10)
            if (!isNaN(index) && base64Images[index]) {
              resolvedSrc = base64Images[index]
            }
          } else if (!src.startsWith('data:') && !src.startsWith('http://') && !src.startsWith('https://') && baseHref) {
            try {
              resolvedSrc = new URL(src, baseHref).toString()
            } catch { /* keep the original src if URL resolution fails */ }
          }
          tempImages.push({
            alt,
            url: resolvedSrc,
            base64: resolvedSrc.startsWith('data:') ? resolvedSrc : '',
            position: paragraphs.length
          })
        }
        return
      }

      const isBlock = ['p', 'div', 'td', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'article', 'section', 'tr', 'table', 'ul', 'ol', 'pre'].includes(tagName)

      if (isBlock) {
        commitParagraph()
        currentTag = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName) ? tagName : 'p'
      }

      if (tagName === 'br') {
        commitParagraph()
      } else {
        for (let i = 0; i < el.childNodes.length; i++) {
          walk(el.childNodes[i])
        }
      }

      if (isBlock) {
        commitParagraph()
      }
    }
  }

  const bodyEl = doc.body || doc.documentElement
  walk(bodyEl)
  commitParagraph()

  // 5. Fetch images in batches until we have 100 successful ones
  const successfulImages: { index: number; alt: string; base64: string; position: number; failedAnalysis?: boolean }[] = []
  const maxImagesDownload = 100
  const batchSize = 20
  let i = 0

  while (successfulImages.length < maxImagesDownload && i < tempImages.length) {
    const batch = tempImages.slice(i, i + batchSize)
    i += batchSize

    const results = await Promise.all(
      batch.map(async (img) => {
        let b64 = img.base64
        if (!b64 && img.url) {
          b64 = await fetchImageAsBase64(img.url)
        }
        if (b64) {
          return {
            alt: img.alt,
            base64: b64,
            position: img.position
          }
        }
        return null
      })
    )

    for (const res of results) {
      if (res) {
        successfulImages.push({
          index: successfulImages.length,
          alt: res.alt,
          base64: res.base64,
          position: res.position,
          failedAnalysis: false
        })
        if (successfulImages.length >= maxImagesDownload) {
          break
        }
      }
    }
  }

  return {
    title,
    paragraphs,
    images: successfulImages,
    totalParagraphs: paragraphs.length,
    totalImages: successfulImages.length
  }
}
