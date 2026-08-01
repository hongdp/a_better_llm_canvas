/**
 * Backend transport for the URL/HTML import pipeline.
 * Wraps the `/api/import-url` and `/api/import-file` endpoints plus local
 * FileReader access. Extracted from ImportUrlModal.tsx.
 */

import type { ScrapedData } from '../../types/import'
import { errorMessage } from './errors'

// Get CSRF token from cookie
export const getCsrfToken = (): string => {
  const nameEQ = 'csrf_token='
  const ca = document.cookie.split(';')
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i]
    while (c.charAt(0) === ' ') c = c.substring(1, c.length)
    if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length))
  }
  return ''
}

// Turn a failed backend response into a descriptive Error (both import
// endpoints share the same error payload shape and 502 fallback message).
const throwHttpError = async (resp: Response): Promise<never> => {
  let errData: { detail?: string; error?: string }
  try {
    errData = await resp.json()
  } catch {
    if (resp.status === 502) {
      errData = { detail: '后端 API 服务未启动或无法连接。请确保 Python 后端已正常运行在 3000 端口。' }
    } else {
      errData = { detail: resp.statusText || `HTTP ${resp.status}` }
    }
  }
  throw new Error(errData.detail || errData.error || `HTTP ${resp.status}`)
}

// Fetch URL content from backend
export const fetchScrapedDataFromUrl = async (url: string): Promise<ScrapedData> => {
  const csrfToken = getCsrfToken()
  const resp = await fetch('/api/import-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken
    },
    body: JSON.stringify({ url })
  })

  if (!resp.ok) {
    await throwHttpError(resp)
  }

  try {
    return await resp.json()
  } catch (e) {
    throw new Error(`解析服务器返回的数据失败：${errorMessage(e)}`, { cause: e })
  }
}

// Upload a raw local HTML file to the backend parser (used for large files
// to prevent browser tab crash/OOM).
export const uploadScrapedHtmlFile = async (file: File): Promise<ScrapedData> => {
  const csrfToken = getCsrfToken()
  const resp = await fetch('/api/import-file', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/html',
      'x-csrf-token': csrfToken
    },
    body: file // Upload the raw file directly as the request body
  })

  if (!resp.ok) {
    await throwHttpError(resp)
  }

  try {
    return await resp.json()
  } catch (err) {
    throw new Error(`解析服务器返回的数据失败：${errorMessage(err)}`, { cause: err })
  }
}

// Read a local file as text via FileReader.
export const readFileAsText = (file: File): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (evt) => resolve(evt.target?.result as string)
    reader.onerror = (err) => reject(err)
    reader.readAsText(file)
  })
