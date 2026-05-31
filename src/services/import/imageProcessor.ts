/**
 * Image processing utilities for the import pipeline.
 * Handles GIF-to-static conversion and scraping data preprocessing.
 */
import type { ScrapedData } from '../../types/import'

/**
 * Fetch an image URL and return its base64 data URL representation.
 */
export const fetchImageAsBase64 = async (urlStr: string): Promise<string> => {
  if (urlStr.startsWith('data:')) return urlStr
  try {
    const res = await fetch(urlStr, { mode: 'cors' })
    if (!res.ok) return ''
    const blob = await res.blob()
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch (e) {
    console.warn('CORS or network error fetching image for local analysis:', urlStr, e)
    return ''
  }
}

/**
 * Convert a GIF base64 data URL to a static JPEG by drawing the first frame onto a canvas.
 */
export const convertGifToStatic = (gifBase64: string): Promise<string> => {
  return new Promise<string>((resolve) => {
    if (!gifBase64.startsWith('data:image/gif')) {
      resolve(gifBase64)
      return
    }

    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        if (ctx) {
          // Fill background with white to handle transparent GIFs cleanly in JPEG format
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(img, 0, 0)
          const staticBase64 = canvas.toDataURL('image/jpeg', 0.85)
          resolve(staticBase64)
        } else {
          resolve(gifBase64)
        }
      } catch (e) {
        console.warn('Failed to convert GIF to static image:', e)
        resolve(gifBase64)
      }
    }
    img.onerror = () => {
      resolve(gifBase64)
    }
    img.src = gifBase64
  })
}

/**
 * Pre-process scraped data by converting any GIF images to static JPEGs.
 */
export const preprocessScrapedData = async (data: ScrapedData): Promise<ScrapedData> => {
  if (!data.images || data.images.length === 0) return data

  const processedImages = await Promise.all(
    data.images.map(async (img) => {
      if (img.base64 && img.base64.startsWith('data:image/gif')) {
        const staticBase64 = await convertGifToStatic(img.base64)
        return {
          ...img,
          base64: staticBase64
        }
      }
      return img
    })
  )

  return {
    ...data,
    images: processedImages
  }
}

/**
 * Load an image and return its dimensions.
 */
export const getImageDimensions = (base64: string): Promise<{ width: number; height: number; success: boolean }> => {
  return new Promise((resolve) => {
    const img = new window.Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight, success: true })
    }
    img.onerror = () => {
      resolve({ width: 0, height: 0, success: false })
    }
    img.src = base64
  })
}
