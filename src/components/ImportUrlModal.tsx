import React, { useState, useRef, useEffect } from 'react'
import { Globe, X, RefreshCw, Sparkles, CheckCircle, AlertCircle, FileText } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { streamLLM } from '../services/llm'
import type { LLMMessage } from '../services/llm'

const fetchImageAsBase64 = async (urlStr: string): Promise<string> => {
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

const convertGifToStatic = (gifBase64: string): Promise<string> => {
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

const preprocessScrapedData = async (data: ScrapedData): Promise<ScrapedData> => {
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

const parseHtmlToScrapedData = async (htmlText: string, filename: string): Promise<ScrapedData> => {
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
            } catch (e) {}
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


interface ScrapedData {
  title: string
  paragraphs: { index: number; text: string; tag: string }[]
  images: { index: number; alt: string; base64: string; position: number; failedAnalysis?: boolean }[]
  totalParagraphs: number
  totalImages: number
}

interface ChapterPlan {
  bookTitle: string
  summary: string
  chapters: {
    chapterNumber: number
    title: string
    description: string
    paragraphRange: [number, number]
    imageIndices: number[]
    mood: string
  }[]
}

interface GeneratedChapter {
  chapterNumber: number
  title: string
  content: string
}

interface FailedPromptContext {
  phase: 1 | 2
  enrichedData: ScrapedData
  plan?: ChapterPlan
  chapterIndex?: number
  generatedChapters?: GeneratedChapter[]
}

type ImportStatus = 'idle' | 'fetching' | 'preview' | 'analyzing' | 'generating' | 'done' | 'error' | 'prompt_edit'

// Helper to determine if an error was caused by LLM safety guidelines / filters
const isSafetyError = (err: any): boolean => {
  const msg = String(err.message || err).toLowerCase()
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

// Escape special characters in word for safe RegExp usage
const escapeRegExp = (str: string): string => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Censor highly explicit sexual/sensitive Chinese keywords to bypass deterministic safety filters
const censorSensitiveText = (text: string, words: string[]): string => {
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

interface ImportUrlModalProps {
  isOpen: boolean
  onClose: () => void
}

export const ImportUrlModal: React.FC<ImportUrlModalProps> = ({ isOpen, onClose }) => {
  const {
    importAllDocuments,
    setBookTitle,
    providerConfigs,
    activeProvider,
    customSystemPrompts,
    activeSystemPromptId,
    debugMode,
    imageAnalysisPrompt
  } = useAppStore()

  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<ImportStatus>('idle')
  const [progress, setProgress] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [scrapedData, setScrapedData] = useState<ScrapedData | null>(null)
  const [chapterPlan, setChapterPlan] = useState<ChapterPlan | null>(null)
  const [generatedChapters, setGeneratedChapters] = useState<GeneratedChapter[]>([])
  const [analyzedIndices, setAnalyzedIndices] = useState<number[]>([])
  const [sensitiveWords, setSensitiveWords] = useState<string[]>([])
  const [failedPromptContext, setFailedPromptContext] = useState<FailedPromptContext | null>(null)
  const [editableSystemPrompt, setEditableSystemPrompt] = useState('')
  const [editableUserPrompt, setEditableUserPrompt] = useState('')
  const abortControllerRef = useRef<AbortController | null>(null)
  const localFileInputRef = useRef<HTMLInputElement>(null)

  const resetState = () => {
    setUrl('')
    setStatus('idle')
    setProgress('')
    setErrorMsg('')
    setScrapedData(null)
    setChapterPlan(null)
    setGeneratedChapters([])
    setAnalyzedIndices([])
    setSensitiveWords([])
    setFailedPromptContext(null)
    setEditableSystemPrompt('')
    setEditableUserPrompt('')
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }

  useEffect(() => {
    if (isOpen) {
      fetch('/sensitive_words.json')
        .then(res => {
          if (!res.ok) {
            throw new Error(`Failed to load sensitive words: ${res.status}`)
          }
          return res.json()
        })
        .then((data: string[]) => {
          if (Array.isArray(data)) {
            setSensitiveWords(data)
          }
        })
        .catch(err => {
          console.warn('Could not load sensitive_words.json, defaulting to empty list.', err)
          setSensitiveWords([])
        })
    }
  }, [isOpen])

  const handleClose = () => {
    if (status === 'fetching' || status === 'analyzing' || status === 'generating') {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
    if (generatedChapters.length > 0) {
      try {
        const planToUse = failedPromptContext?.plan || chapterPlan
        if (planToUse) {
          importChaptersAndOutline(failedPromptContext?.enrichedData || scrapedData!, planToUse, generatedChapters, true)
        }
      } catch (e) {
        console.error('Failed to import on close', e)
      }
    }
    resetState()
    onClose()
  }

  const handleSaveAndExit = () => {
    if (scrapedData && generatedChapters.length > 0) {
      const planToUse = failedPromptContext?.plan || chapterPlan
      if (planToUse) {
        importChaptersAndOutline(failedPromptContext?.enrichedData || scrapedData, planToUse, generatedChapters, true)
        setStatus('done')
        setProgress(`✅ 已导入已生成的前 ${generatedChapters.length} 个章节并退出`)
        return
      }
    }
    resetState()
    onClose()
  }

  // Get CSRF token from cookie
  const getCsrfToken = (): string => {
    const nameEQ = 'csrf_token='
    const ca = document.cookie.split(';')
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i]
      while (c.charAt(0) === ' ') c = c.substring(1, c.length)
      if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length))
    }
    return ''
  }

  // Step 1: Fetch URL content from backend
  const handleFetch = async () => {
    if (!url.trim()) return

    setStatus('fetching')
    setProgress('正在抓取网页内容...')
    setErrorMsg('')

    try {
      const csrfToken = getCsrfToken()
      const resp = await fetch('/api/import-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify({ url: url.trim() })
      })

      if (!resp.ok) {
        let errData: any = null
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

      let data: ScrapedData
      try {
        data = await resp.json()
      } catch (e: any) {
        throw new Error(`解析服务器返回的数据失败：${e.message || e}`)
      }

      if (data.totalParagraphs === 0) {
        throw new Error('未能从该页面提取到任何文字内容。')
      }

      const processedData = await preprocessScrapedData(data)
      setScrapedData(processedData)
      setStatus('preview')
      setProgress('')
    } catch (err: any) {
      setStatus('error')
      setErrorMsg(err.message || '抓取失败')
    }
  }

  const handleLocalFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const file = files[0]
    setStatus('fetching')
    setErrorMsg('')

    try {
      let data: ScrapedData

      // If file is large (>= 5MB), upload to backend parser to prevent browser tab crash/OOM
      if (file.size >= 5 * 1024 * 1024) {
        setProgress(`文件较大 (${(file.size / (1024 * 1024)).toFixed(1)}MB)，正在上传至服务器解析...`)
        
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
          let errData: any = null
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

        try {
          data = await resp.json()
        } catch (err: any) {
          throw new Error(`解析服务器返回的数据失败：${err.message || err}`)
        }
      } else {
        // For small files (< 5MB), parse client-side to save bandwidth
        setProgress('正在读取本地网页文件...')
        const text = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = (evt) => resolve(evt.target?.result as string)
          reader.onerror = (err) => reject(err)
          reader.readAsText(file)
        })

        setProgress('正在解析网页结构...')
        data = await parseHtmlToScrapedData(text, file.name)
      }
      
      if (data.totalParagraphs === 0) {
        throw new Error('未能从该本地 HTML 文件中提取到任何文字内容。')
      }

      const processedData = await preprocessScrapedData(data)
      setScrapedData(processedData)
      setStatus('preview')
      setProgress('')
    } catch (err: any) {
      setStatus('error')
      setErrorMsg(err.message || '读取或解析本地网页失败')
    } finally {
      if (localFileInputRef.current) {
        localFileInputRef.current.value = ''
      }
    }
  }

  // Helper: Extract JSON from LLM output (handles markdown code blocks)
  const extractJson = (text: string): string => {
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

  // Get the active LLM config
  const getActiveConfig = () => {
    const config = providerConfigs[activeProvider]
    return { ...config, provider: activeProvider, debug: debugMode }
  }

  // Get user's custom system prompt content
  const getUserCustomPrompt = (): string => {
    const activePrompt = customSystemPrompts.find(p => p.id === activeSystemPromptId) || customSystemPrompts[0]
    return activePrompt?.content || ''
  }

  // Build content with image descriptions embedded inline at their original positions
  const buildInterleavedContent = (data: ScrapedData): string => {
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

  // Step 2: Run Phase 1 - Content Analysis & Chapter Planning
  const runPhase1 = async (data: ScrapedData): Promise<ChapterPlan> => {
    setStatus('analyzing')
    setProgress('Phase 1: AI 正在分析内容结构，规划章节...')

    const doAnalysisAttempt = (censored: boolean): Promise<ChapterPlan> => {
      const processedData = censored ? {
        ...data,
        paragraphs: data.paragraphs.map(p => ({
          ...p,
          text: censorSensitiveText(p.text, sensitiveWords)
        })),
        images: data.images.map(img => ({
          ...img,
          alt: censorSensitiveText(img.alt || '', sensitiveWords)
        }))
      } : data

      const interleavedContent = buildInterleavedContent(processedData)
      const userCustomPrompt = getUserCustomPrompt()

      const systemPrompt: LLMMessage = {
        role: 'system',
        content: `你是一位专业的文学编辑和小说策划师。你的任务是分析提供的网页原始内容，理解其中的故事情节、人物、场景和情感线索，然后将其规划为一部小说的章节结构。

${userCustomPrompt ? `用户自定义写作指导：\n${userCustomPrompt}\n\n` : ''}注意：原文中的 [📷 图片描述 IMG-N] 标记表示该位置有一张配图，描述了图片的内容。请在规划章节时考虑这些图片的位置 and 内容。

任务要求：
1. 仔细阅读全部原文内容（包括图片描述）
2. 识别故事的主要情节线、场景转换、情感变化
3. 将内容划分为合适的章节（通常3-8章，取决于内容长度）
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

      const config = getActiveConfig()

      return new Promise<ChapterPlan>((resolve, reject) => {
        abortControllerRef.current = new AbortController()
        let accumulated = ''

        streamLLM(
          [systemPrompt, userPrompt],
          { ...config, signal: abortControllerRef.current.signal },
          {
            onChunk: (chunk: string) => {
              accumulated += chunk
            },
            onDone: (fullText: string) => {
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
                setChapterPlan(plan)
                resolve(plan)
              } catch (e: any) {
                reject(new Error(`解析章节规划失败: ${e.message}. LLM输出: ${fullText.substring(0, 200)}...`))
              }
            },
            onError: (err: Error) => {
              const enrichedErr = err as any
              enrichedErr.systemPrompt = systemPrompt
              enrichedErr.userPrompt = userPrompt
              reject(enrichedErr)
            }
          }
        )
      })
    }

    try {
      return await doAnalysisAttempt(false)
    } catch (err: any) {
      if (isSafetyError(err)) {
        console.warn('Phase 1 failed due to safety guidelines. Retrying with censored content...', err)
        setProgress('Phase 1 (安全重试): 发现内容敏感，正在对关键词进行本地脱敏后重新规划章节...')
        try {
          return await doAnalysisAttempt(true)
        } catch (censoredErr: any) {
          if (isSafetyError(censoredErr)) {
            censoredErr.isSafetyPromptContext = true
            censoredErr.phase = 1
          }
          throw censoredErr
        }
      }
      throw err
    }
  }

  // Helper to slice and build interleaved content for a single chapter
  const buildChapterInterleavedContent = (data: ScrapedData, paragraphRange: [number, number], _imageIndices: number[]): string => {
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

  // Helper to get the ending of the previous chapter
  const getPreviousChapterEnding = (prevCh: GeneratedChapter | undefined): string => {
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

  // Step 3: Run Phase 2 - Novel Chapter Generation
  const runPhase2 = async (
    data: ScrapedData,
    plan: ChapterPlan,
    onChapterGenerated?: (ch: GeneratedChapter) => void,
    startIndex = 0,
    existingChapters: GeneratedChapter[] = []
  ): Promise<GeneratedChapter[]> => {
    setStatus('generating')
    setProgress('Phase 2: 正在初始化小说章节生成...')

    const userCustomPrompt = getUserCustomPrompt()
    const config = getActiveConfig()
    const generated: GeneratedChapter[] = [...existingChapters]

    for (let i = startIndex; i < plan.chapters.length; i++) {
      const chPlan = plan.chapters[i]
      setProgress(`Phase 2: 正在生成第 ${i + 1}/${plan.chapters.length} 章节 (${chPlan.title})...`)

      const prevEnding = getPreviousChapterEnding(generated[i - 1])
      
      // Get images for this chapter
      const chImages = chPlan.imageIndices
        .map(idx => data.images.find(img => img.index === idx))
        .filter((img): img is NonNullable<typeof img> => !!img)

      let attempt = 1
      const maxAttempts = 3
      let chapterResult: GeneratedChapter | null = null

      while (attempt <= maxAttempts) {
        let systemPrompt: LLMMessage = { role: 'system', content: '' }
        let userPrompt: LLMMessage = { role: 'user', content: '' }
        try {
          let currentImages = chImages.filter(img => !img.failedAnalysis)
          let currentImageDescriptions = chImages.map(img => `- IMG-${img.index}: ${img.alt || '无描述'}`).join('\n')
          let currentInterleavedContent = buildChapterInterleavedContent(data, chPlan.paragraphRange, chPlan.imageIndices)
          
          if (attempt >= 2) {
            // Attempt 2: Strip all base64 images and simplify alt texts
            currentImages = []
            currentImageDescriptions = chImages.map(img => `- IMG-${img.index}: （配图已脱敏）`).join('\n')
            const cleanData = {
              ...data,
              images: data.images.map(img => ({ ...img, alt: '（配图已脱敏）' }))
            }
            currentInterleavedContent = buildChapterInterleavedContent(cleanData, chPlan.paragraphRange, chPlan.imageIndices)
          }

          if (attempt >= 3) {
            // Attempt 3: Omit images, simplify alt texts, and censor explicit text paragraphs
            currentImages = []
            currentImageDescriptions = chImages.map(img => `- IMG-${img.index}: （配图已脱敏）`).join('\n')
            const censoredParagraphs = data.paragraphs.map(p => ({
              ...p,
              text: censorSensitiveText(p.text, sensitiveWords)
            }))
            const censoredData = {
              ...data,
              paragraphs: censoredParagraphs,
              images: data.images.map(img => ({ ...img, alt: '（配图已脱敏）' }))
            }
            currentInterleavedContent = buildChapterInterleavedContent(censoredData, chPlan.paragraphRange, chPlan.imageIndices)
          }

          systemPrompt = {
            role: 'system',
            content: `你是一位才华横溢的小说家。你的任务是根据提供的小说大纲、前文结尾、当前章节规划和原始素材，创作当前章节的精彩小说内容。

${userCustomPrompt ? `用户自定义写作指导：\n${userCustomPrompt}\n\n` : ''}注意：原文中的 [📷 图片描述 IMG-N] 标记表示该位置有一张配图。请在改写时：
- 将图片描述的内容自然融入叙事（描写图片中展现的场景、环境氛围等）。
- 在图片应该出现的位置使用 {{IMG-N}} 占位标记，前端会自动替换为实际图片。

写作要求：
1. 保持原文的核心情节和信息不变。
2. 用优美的文学语言改写，增加丰富的细节描写、心理活动 and 生动的对话。
3. 注意叙事连贯性：请仔细阅读提供的“前文结尾”，保证本章的开头能与其无缝、流畅地承接。
4. 章节的篇幅应该比原文更充实，但不要为了字数而注水。
5. 使用与原文相同的语言。

输出格式要求：
- 只输出一个合法的 JSON 对象，不要有任何其他文字。
- 使用 HTML 格式（p, em, strong 等标签），并以 <h1>当前章节标题</h1> 作为开头。
- 在图片应该出现的位置，使用占位标记 {{IMG-N}}（N为图片编号）。

JSON格式：
{
  "chapterNumber": ${chPlan.chapterNumber},
  "title": "${chPlan.title.replace(/"/g, '\\"')}",
  "content": "<h1>${chPlan.title.replace(/"/g, '\\"')}</h1><p>正文第一段...</p><p>{{IMG-N}}</p><p>正文第二段...</p>"
}`
          }

          userPrompt = {
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

【本章写作规划】
本章标题: ${chPlan.title}
本章情感基调: ${chPlan.mood}
本章段落范围: P${chPlan.paragraphRange[0]} 至 P${chPlan.paragraphRange[1]}
本章包含的配图编号: ${chPlan.imageIndices.length > 0 ? chPlan.imageIndices.map(index => `IMG-${index}`).join(', ') : '无'}

【本章相关配图描述】
${currentImageDescriptions}

【本章对应的原始素材（段落与配图）】
---
${currentInterleavedContent}
---

请根据本章规划和素材，创作本章的完整小说正文，输出合法的 JSON 格式。并在合适的位置插入对应的 {{IMG-N}} 占位符。`,
            images: currentImages.map(img => img.base64)
          }

          chapterResult = await new Promise<GeneratedChapter>((resolve, reject) => {
            abortControllerRef.current = new AbortController()
            let accumulated = ''

            streamLLM(
              [systemPrompt, userPrompt],
              { ...config, signal: abortControllerRef.current.signal },
              {
                onChunk: (chunk: string) => {
                  accumulated += chunk
                  setProgress(`Phase 2: 正在生成第 ${i + 1}/${plan.chapters.length} 章节 (${chPlan.title})... (${accumulated.length} 字)${attempt > 1 ? ` (重试中 ${attempt}/${maxAttempts})` : ''}`)
                },
                onDone: (fullText: string) => {
                  try {
                    const jsonStr = extractJson(fullText)
                    const chObj = JSON.parse(jsonStr) as GeneratedChapter
                    if (!chObj.content || !chObj.title) {
                      throw new Error('JSON 中缺少 title 或 content 字段')
                    }
                    resolve(chObj)
                  } catch (e: any) {
                    reject(new Error(`解析第 ${chPlan.chapterNumber} 章失败: ${e.message}. LLM 输出: ${fullText.substring(0, 200)}`))
                  }
                },
                onError: (err: Error) => {
                  reject(err)
                }
              }
            )
          })

          // Success - break out of the retry loop
          break

        } catch (err: any) {
          if (abortControllerRef.current?.signal.aborted) {
            throw err
          }

          const isSafety = isSafetyError(err)
          if (isSafety && attempt < maxAttempts) {
            console.warn(`[Phase 2 Safety Alert] Chapter ${chPlan.chapterNumber} blocked by safety policy. Retrying with simplified inputs. Attempt ${attempt}/${maxAttempts}. Error:`, err)
            attempt++
            setProgress(`Phase 2: 第 ${i + 1}/${plan.chapters.length} 章节被安全过滤拦截，正在重试 (第 ${attempt}/${maxAttempts} 次尝试)...`)
            // Wait 1 second before retrying
            await new Promise(r => setTimeout(r, 1000))
          } else {
            if (isSafety) {
              err.isSafetyPromptContext = true
              err.phase = 2
              err.systemPrompt = systemPrompt
              err.userPrompt = userPrompt
              err.chapterIndex = i
            }
            // Not a safety error or max attempts reached, propagate the error
            throw err
          }
        }
      }

      if (chapterResult) {
        generated.push(chapterResult)
        setGeneratedChapters([...generated])
        if (onChapterGenerated) {
          onChapterGenerated(chapterResult)
        }
      } else {
        throw new Error(`生成第 ${chPlan.chapterNumber} 章失败: 发生未知错误`)
      }
    }

    return generated
  }

  // Replace {{IMG-N}} placeholders with actual <img> tags
  const replaceImagePlaceholders = (content: string, images: ScrapedData['images']): string => {
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

  // Helper to load image and get dimensions
  const getImageDimensions = (base64: string): Promise<{ width: number; height: number; success: boolean }> => {
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

  // Phase 0: Use LLM vision to analyze and describe images
  const analyzeImages = async (data: ScrapedData): Promise<ScrapedData> => {
    // Filter images suitable for vision API
    const VISION_SAFE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg']
    
    const updatedImages = [...data.images]

    // 1. Initial quick MIME and length filter, and flag unsuitable ones immediately
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

    const candidateImages = updatedImages.filter(img => !img.failedAnalysis)

    if (candidateImages.length === 0) {
      // Update state in real-time so UI reflects invalid/tiny images immediately
      setScrapedData({ ...data, images: updatedImages })
      return { ...data, images: updatedImages }
    }

    // 2. Resolve dimensions in parallel (only for candidates to prevent resource contention)
    const dimensionsResults = await Promise.all(
      candidateImages.map(async (img) => {
        const dims = await getImageDimensions(img.base64)
        return { img, ...dims }
      })
    )

    // Flag invalid or tiny images immediately as failedAnalysis so they are not sent to LLM in Phase 2
    for (const res of dimensionsResults) {
      const totalPixels = res.width * res.height
      const isTiny = totalPixels < 512 || res.width < 20 || res.height < 20
      if (!res.success || isTiny) {
        const globalIdx = updatedImages.findIndex(imgItem => imgItem.index === res.img.index)
        if (globalIdx !== -1) {
          updatedImages[globalIdx] = {
            ...updatedImages[globalIdx],
            alt: !res.success 
              ? '（配图加载失败: 格式无效或非可用图片）'
              : '（配图尺寸过小，已忽略分析）',
            failedAnalysis: true
          }
        }
      }
    }

    // 3. Filter by dimensions (OpenAI / Grok requires >= 512 total pixels)
    const validImages = dimensionsResults
      .filter(({ img, width, height, success }) => {
        if (!success) return false
        const totalPixels = width * height
        if (totalPixels < 512 || width < 20 || height < 20) {
          console.warn(`[Image Analysis] Skipping tiny or invalid image IMG-${img.index} (${width}x${height}, total pixels: ${totalPixels})`)
          return false
        }
        return true
      })
      .map(({ img }) => img)

    // Update state in real-time so UI reflects invalid/tiny images immediately
    setScrapedData({ ...data, images: updatedImages })

    if (validImages.length === 0) {
      return { ...data, images: updatedImages } // Return updated images even if none need analysis
    }

    setStatus('analyzing')
    setProgress(`Phase 0: AI 正在并行分析 ${validImages.length} 张配图...`)

    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    let completedCount = 0
    const concurrencyLimit = 10

    // Worker function for each image
    const processImage = async (img: typeof validImages[0]) => {
      const systemPrompt: LLMMessage = {
        role: 'system',
        content: imageAnalysisPrompt.replace('{{index}}', String(img.index))
      }

      const userPrompt: LLMMessage = {
        role: 'user',
        content: `请描述这张图片。图片编号为: IMG-${img.index}`,
        images: [img.base64]
      }

      const config = getActiveConfig()

      try {
        const descriptions = await new Promise<{ index: any; description: string }[]>((resolve, reject) => {
          let accumulated = ''

          streamLLM(
            [systemPrompt, userPrompt],
            { ...config, signal },
            {
              onChunk: (chunk: string) => {
                accumulated += chunk
              },
              onDone: (fullText: string) => {
                try {
                  const jsonStr = extractJson(fullText)
                  const result = JSON.parse(jsonStr)
                  const descs = result.descriptions || result
                  if (Array.isArray(descs)) {
                    resolve(descs)
                  } else {
                    reject(new Error('LLM 返回的图片描述格式不正确。'))
                  }
                } catch {
                  console.warn('[Image Analysis] Failed to parse JSON, using fallback parser')
                  const fallbackDescs: { index: any; description: string }[] = []
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
                    resolve(fallbackDescs)
                  } else {
                    reject(new Error('无法解析 LLM 的图片分析输出。'))
                  }
                }
              },
              onError: (err: Error) => {
                reject(err)
              }
            }
          )
        })

        // Update image descriptions with LLM results
        for (const desc of descriptions) {
          let imgIndex = -1
          if (typeof desc.index === 'number') {
            imgIndex = desc.index
          } else if (typeof desc.index === 'string') {
            const numMatch = desc.index.match(/\d+/)
            if (numMatch) {
              imgIndex = parseInt(numMatch[0], 10)
            }
          }

          let targetImg = null
          if (imgIndex === img.index || imgIndex === 0 || descriptions.length === 1) {
            targetImg = img
          }

          if (targetImg && desc.description) {
            const globalIdx = updatedImages.findIndex(imgItem => imgItem.index === targetImg.index)
            if (globalIdx !== -1) {
              updatedImages[globalIdx] = {
                ...updatedImages[globalIdx],
                alt: desc.description
              }
              const currentImgIndex = targetImg.index
              setAnalyzedIndices(prev => [currentImgIndex, ...prev.filter(idx => idx !== currentImgIndex)])
              setScrapedData(prev => prev ? { ...prev, images: [...updatedImages] } : null)
            }
          }
        }

        completedCount++
        setProgress(`Phase 0: AI 正在分析配图... (已完成 ${completedCount}/${validImages.length})`)

      } catch (err: any) {
        if (signal.aborted) {
          throw err
        }
        console.warn(`[Image Analysis] Image processing failed for IMG-${img.index}:`, err)
        
        // Mark image analysis as failed, and set a fallback description to degrade gracefully.
        // Unsafe or problematic images will not break the entire scraping workflow.
        const globalIdx = updatedImages.findIndex(imgItem => imgItem.index === img.index)
        if (globalIdx !== -1) {
          updatedImages[globalIdx] = {
            ...updatedImages[globalIdx],
            alt: `（配图分析已跳过: 内容触发安全过滤或接口限制）`,
            failedAnalysis: true
          }
          const currentImgIndex = img.index
          setAnalyzedIndices(prev => [currentImgIndex, ...prev.filter(idx => idx !== currentImgIndex)])
          setScrapedData(prev => prev ? { ...prev, images: [...updatedImages] } : null)
        }

        completedCount++
        setProgress(`Phase 0: AI 正在分析配图... (已完成 ${completedCount}/${validImages.length})`)
      }
    }

    // Run tasks with concurrency limit
    const executing: Promise<any>[] = []
    const results: Promise<any>[] = []
    
    for (const img of validImages) {
      const p = processImage(img)
      results.push(p)
      if (concurrencyLimit < validImages.length) {
        const e: Promise<any> = p.then(() => {
          const index = executing.indexOf(e)
          if (index > -1) executing.splice(index, 1)
        })
        executing.push(e)
        if (executing.length >= concurrencyLimit) {
          await Promise.race(executing)
        }
      }
    }

    await Promise.all(results)

    // Return updated scraped data with enriched descriptions
    const enrichedData = { ...data, images: updatedImages }
    setScrapedData(enrichedData)
    return enrichedData
  }

  // Helper to compile HTML for the outline page and import all completed chapters into the Canvas workspace.
  const importChaptersAndOutline = (
    enrichedData: ScrapedData,
    plan: ChapterPlan,
    chapters: GeneratedChapter[],
    partial = false
  ) => {
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

    const allDocs = [outlineDoc, ...novelDocs]
    importAllDocuments(allDocs)
    setBookTitle((plan.bookTitle || enrichedData.title) + (partial ? ' (部分生成)' : ''))
  }

  // Handles pipeline errors, including safety blocks and cancellations
  const handlePipelineError = (
    err: any,
    context: {
      enrichedData: ScrapedData
      plan?: ChapterPlan
      chapterIndex?: number
      generatedChapters: GeneratedChapter[]
    }
  ) => {
    const isAbort = err.message?.includes('abort') || err.name === 'AbortError'
    const isSafety = err.isSafetyPromptContext || isSafetyError(err)

    if (isSafety) {
      console.warn('[Pipeline Error] Triggered safety guidelines filter:', err)
      setFailedPromptContext({
        phase: context.plan ? 2 : 1,
        enrichedData: context.enrichedData,
        plan: context.plan,
        chapterIndex: context.chapterIndex ?? 0,
        generatedChapters: context.generatedChapters
      })
      setEditableSystemPrompt(err.systemPrompt?.content || '')
      setEditableUserPrompt(err.userPrompt?.content || '')
      setStatus('prompt_edit')
      setProgress('⚠️ 内容可能违反了服务商的安全合规策略。请在下方修改 Prompt 后手动重试。')
      return
    }

    if (context.generatedChapters.length > 0) {
      try {
        const planToUse = context.plan || chapterPlan
        if (planToUse) {
          importChaptersAndOutline(context.enrichedData, planToUse, context.generatedChapters, true)
          if (isAbort) {
            setStatus('done')
            setProgress(`✅ 取消成功：已导入已生成的前 ${context.generatedChapters.length} 个章节（含大纲）`)
          } else {
            setStatus('error')
            setErrorMsg(`生成中断。已为您导入前 ${context.generatedChapters.length} 个生成的章节（含大纲）。错误原因: ${err.message || err}`)
          }
          return
        }
      } catch (importErr) {
        console.error('[Partial Import] Failed to import partially generated documents:', importErr)
      }
    }

    if (isAbort) {
      setStatus('preview')
      setProgress('已取消')
      return
    }
    setStatus('error')
    setErrorMsg(err.message || '生成失败')
  }

  // Helper to execute Phase 2 generation and coordinate outline/chapter imports
  const executePhase2AndImport = async (
    enrichedData: ScrapedData,
    plan: ChapterPlan,
    startIndex = 0,
    existingChapters: GeneratedChapter[] = []
  ) => {
    const generatedList = [...existingChapters]
    try {
      const chapters = await runPhase2(
        enrichedData,
        plan,
        (ch) => {
          generatedList.push(ch)
          setGeneratedChapters([...generatedList])
        },
        startIndex,
        existingChapters
      )

      importChaptersAndOutline(enrichedData, plan, chapters, false)
      setStatus('done')
      setProgress(`✅ 生成完成！已创建 ${chapters.length + 1} 个章节（含大纲）`)
    } catch (err: any) {
      handlePipelineError(err, {
        enrichedData,
        plan,
        chapterIndex: generatedList.length,
        generatedChapters: generatedList
      })
    }
  }

  // Handle manual retry after editing prompts in UI
  const handleManualRetry = async () => {
    if (!failedPromptContext) return
    setErrorMsg('')
    
    const { phase, enrichedData, plan, chapterIndex, generatedChapters = [] } = failedPromptContext
    setStatus(phase === 1 ? 'analyzing' : 'generating')
    setProgress(phase === 1 ? '正在根据您修改后的 Prompt 重新规划章节...' : `正在根据您修改后的 Prompt 生成第 ${(chapterIndex ?? 0) + 1} 章...`)

    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal
    const config = getActiveConfig()

    const sysMsg: LLMMessage = { role: 'system', content: editableSystemPrompt }
    const userMsg: LLMMessage = { 
      role: 'user', 
      content: editableUserPrompt,
      images: phase === 2 && plan && chapterIndex !== undefined
        ? plan.chapters[chapterIndex].imageIndices
            .map(idx => enrichedData.images.find(img => img.index === idx))
            .filter((img): img is NonNullable<typeof img> => !!img && !img.failedAnalysis)
            .map(img => img.base64)
        : undefined
    }

    try {
      if (phase === 1) {
        // Phase 1 retry
        const newPlan = await new Promise<ChapterPlan>((resolve, reject) => {
          let accumulated = ''
          streamLLM(
            [sysMsg, userMsg],
            { ...config, signal },
            {
              onChunk: (chunk: string) => {
                accumulated += chunk
              },
              onDone: (fullText: string) => {
                try {
                  let jsonStr = extractJson(fullText)
                  jsonStr = jsonStr.replace(/\[\s*([\s\S]*?)\s*\]/g, (arrayMatch) => {
                    return arrayMatch.replace(/[A-Za-z]+-?(\d+)/g, '$1')
                  })
                  const parsedPlan = JSON.parse(jsonStr) as ChapterPlan
                  if (parsedPlan.chapters && Array.isArray(parsedPlan.chapters)) {
                    parsedPlan.chapters.forEach(ch => {
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
                  if (!parsedPlan.chapters || !Array.isArray(parsedPlan.chapters) || parsedPlan.chapters.length === 0) {
                    throw new Error('LLM 返回的章节规划格式无效')
                  }
                  setChapterPlan(parsedPlan)
                  resolve(parsedPlan)
                } catch (e: any) {
                  reject(new Error(`解析章节规划失败: ${e.message}. LLM输出: ${fullText.substring(0, 200)}...`))
                }
              },
              onError: (err: Error) => {
                const enrichedErr = err as any
                enrichedErr.systemPrompt = sysMsg
                enrichedErr.userPrompt = userMsg
                reject(enrichedErr)
              }
            }
          )
        })

        // On success of Phase 1 retry, proceed with Phase 2
        setFailedPromptContext(null)
        await executePhase2AndImport(enrichedData, newPlan, 0, [])
      } else {
        // Phase 2 retry for a specific chapter
        const failedChapterPlan = plan?.chapters[chapterIndex ?? 0]
        if (!failedChapterPlan) {
          throw new Error('找不到失败章节的规划数据')
        }

        const chapterResult = await new Promise<GeneratedChapter>((resolve, reject) => {
          let accumulated = ''
          streamLLM(
            [sysMsg, userMsg],
            { ...config, signal },
            {
              onChunk: (chunk: string) => {
                accumulated += chunk
                setProgress(`Phase 2: 正在生成第 ${(chapterIndex ?? 0) + 1}/${plan!.chapters.length} 章节 (${failedChapterPlan.title})... (${accumulated.length} 字)`)
              },
              onDone: (fullText: string) => {
                try {
                  const jsonStr = extractJson(fullText)
                  const chObj = JSON.parse(jsonStr) as GeneratedChapter
                  if (!chObj.content || !chObj.title) {
                    throw new Error('JSON 中缺少 title 或 content 字段')
                  }
                  resolve(chObj)
                } catch (e: any) {
                  reject(new Error(`解析第 ${failedChapterPlan.chapterNumber} 章失败: ${e.message}. LLM 输出: ${fullText.substring(0, 200)}`))
                }
              },
              onError: (err: Error) => {
                const enrichedErr = err as any
                enrichedErr.systemPrompt = sysMsg
                enrichedErr.userPrompt = userMsg
                reject(enrichedErr)
              }
            }
          )
        })

        // Success - add the retried chapter and resume Phase 2 for the rest of chapters!
        const updatedGenerated = [...generatedChapters, chapterResult]
        setGeneratedChapters(updatedGenerated)
        setFailedPromptContext(null)
        
        const nextChapterIndex = (chapterIndex ?? 0) + 1
        if (nextChapterIndex < plan!.chapters.length) {
          await executePhase2AndImport(enrichedData, plan!, nextChapterIndex, updatedGenerated)
        } else {
          // No more chapters, finalize
          importChaptersAndOutline(enrichedData, plan!, updatedGenerated, false)
          setStatus('done')
          setProgress(`✅ 生成完成！已创建 ${updatedGenerated.length + 1} 个章节（含大纲）`)
        }
      }
    } catch (err: any) {
      handlePipelineError(err, {
        enrichedData,
        plan,
        chapterIndex,
        generatedChapters
      })
    }
  }

  // Main handler: Start generation pipeline
  const handleStartGeneration = async () => {
    if (!scrapedData) return

    setErrorMsg('')
    setGeneratedChapters([])
    let enrichedData: ScrapedData | null = null

    try {
      // Phase 0: Image description analysis
      enrichedData = await analyzeImages(scrapedData)

      // Phase 1: Analysis
      const plan = await runPhase1(enrichedData)

      // Phase 2: Generation and import
      await executePhase2AndImport(enrichedData, plan, 0, [])
    } catch (err: any) {
      handlePipelineError(err, {
        enrichedData: enrichedData || scrapedData,
        generatedChapters: []
      })
    }
  }

  if (!isOpen) return null

  const previewText = scrapedData
    ? scrapedData.paragraphs.slice(0, 5).map(p => p.text).join('\n').substring(0, 500)
    : ''

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className="modal-content glass-panel"
        onClick={e => e.stopPropagation()}
        style={{
          border: '1px solid var(--border-color)',
          backgroundColor: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          maxWidth: '600px',
          width: '90vw',
          maxHeight: '80vh',
          padding: '1.5rem',
          textAlign: 'left',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border-color)',
          paddingBottom: '0.75rem',
          marginBottom: '1rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Globe size={20} style={{ color: 'var(--accent)' }} />
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>从网页URL / 本地HTML创作</h3>
          </div>
          <button onClick={handleClose} className="btn-icon" title="关闭" type="button" style={{ padding: '0.25rem' }}>
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {/* URL Input / File Upload - Always visible except when done/editing prompt */}
          {status !== 'done' && status !== 'prompt_edit' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="url"
                  placeholder="粘贴网页URL..."
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (status === 'idle' || status === 'error')) handleFetch()
                  }}
                  disabled={status !== 'idle' && status !== 'error'}
                  className="form-input"
                  style={{
                    flex: 1,
                    padding: '0.6rem 0.8rem',
                    fontSize: '0.9rem',
                    backgroundColor: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    color: 'var(--text-primary)',
                    outline: 'none'
                  }}
                />
                {(status === 'idle' || status === 'error') && (
                  <button
                    onClick={handleFetch}
                    disabled={!url.trim()}
                    className="btn-primary"
                    type="button"
                    style={{
                      padding: '0.6rem 1rem',
                      fontSize: '0.85rem',
                      whiteSpace: 'nowrap',
                      opacity: url.trim() ? 1 : 0.5
                    }}
                  >
                    抓取网页
                  </button>
                )}
              </div>
              
              {(status === 'idle' || status === 'error') && (
                <div 
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    gap: '0.5rem', 
                    padding: '1rem', 
                    border: '1px dashed var(--border-color)', 
                    borderRadius: '8px',
                    backgroundColor: 'rgba(255, 255, 255, 0.02)',
                    cursor: 'pointer',
                    transition: 'border-color 0.2s',
                  }}
                  onClick={() => localFileInputRef.current?.click()}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
                >
                  <FileText size={18} style={{ color: 'var(--accent)' }} />
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    或者：上传本地网页文件 (.html, .htm) 进行解析与创作
                  </span>
                  <input
                    type="file"
                    ref={localFileInputRef}
                    onChange={handleLocalFileChange}
                    accept=".html,.htm"
                    style={{ display: 'none' }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Fetching spinner */}
          {status === 'fetching' && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.75rem',
              padding: '2rem',
              color: 'var(--text-secondary)'
            }}>
              <RefreshCw size={20} className="animate-spin" />
              <span>{progress}</span>
            </div>
          )}

          {/* Preview */}
          {(status === 'preview' || status === 'analyzing' || status === 'generating') && scrapedData && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
              padding: '1rem',
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '8px',
              border: '1px solid var(--border-color)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{scrapedData.title}</span>
              </div>

              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', gap: '1rem' }}>
                <span>📄 {scrapedData.totalParagraphs} 段文字</span>
                <span>🖼️ {scrapedData.totalImages} 张配图</span>
              </div>

              {/* Text preview */}
              <div style={{
                fontSize: '0.8rem',
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
                maxHeight: '100px',
                overflowY: 'auto',
                padding: '0.5rem',
                backgroundColor: 'var(--bg-tertiary)',
                borderRadius: '6px',
                whiteSpace: 'pre-wrap'
              }}>
                {previewText}{previewText.length >= 500 ? '...' : ''}
              </div>

              {/* Image thumbnails with descriptions */}
              {scrapedData.images.length > 0 && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  maxHeight: '150px',
                  overflowY: 'auto',
                  padding: '0.5rem',
                  backgroundColor: 'var(--bg-tertiary)',
                  borderRadius: '6px'
                }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px' }}>
                    📷 配图描述（将提供给AI分析）:
                  </div>
                  {(() => {
                    const sortedImages = [
                      ...analyzedIndices
                        .map(idx => scrapedData.images.find(img => img.index === idx))
                        .filter((img): img is NonNullable<typeof img> => !!img),
                      ...scrapedData.images.filter(img => !analyzedIndices.includes(img.index))
                    ]
                    return sortedImages.slice(0, 20).map((img, idx) => (
                      <div key={idx} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '0.75rem'
                      }}>
                        <img
                          src={img.base64}
                          alt={img.alt || `Image ${idx}`}
                          style={{
                            width: '36px',
                            height: '36px',
                            objectFit: 'cover',
                            borderRadius: '4px',
                            border: '1px solid var(--border-color)',
                            flexShrink: 0
                          }}
                        />
                        <span style={{ color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>
                          IMG-{img.index}
                        </span>
                        <span style={{
                          color: 'var(--text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}>
                          {img.alt || '（无文字描述）'}
                        </span>
                      </div>
                    ))
                  })()}
                  {scrapedData.images.length > 20 && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                      ... 还有 {scrapedData.images.length - 20} 张图片
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Chapter Plan Preview */}
          {chapterPlan && (status === 'analyzing' || status === 'generating' || status === 'done') && (
            <div style={{
              padding: '0.75rem',
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '8px',
              border: '1px solid var(--border-color)'
            }}>
              <div style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                marginBottom: '0.5rem',
                color: 'var(--accent)'
              }}>
                📋 章节规划: {chapterPlan.bookTitle}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                {chapterPlan.summary}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {chapterPlan.chapters.map((ch, idx) => (
                  <div key={idx} style={{
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                    padding: '0.25rem 0',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem'
                  }}>
                    <span style={{ color: 'var(--accent)', fontWeight: 500 }}>
                      {generatedChapters.find(g => g.chapterNumber === ch.chapterNumber) ? '✅' : '📖'}
                    </span>
                    <span>{ch.title}</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      ({ch.mood})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Progress during LLM calls */}
          {(status === 'analyzing' || status === 'generating') && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.75rem',
              color: 'var(--text-secondary)',
              fontSize: '0.85rem'
            }}>
              <Sparkles size={16} className="animate-spin" style={{ color: 'var(--accent)' }} />
              <span>{progress}</span>
            </div>
          )}

          {/* Done */}
          {status === 'done' && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1rem',
              padding: '1.5rem',
              color: '#10b981'
            }}>
              <CheckCircle size={40} />
              <span style={{ fontSize: '1rem', fontWeight: 600 }}>{progress}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                所有章节已导入到左侧章节列表中。你可以在编辑器中查看和进一步编辑每个章节。
              </span>
            </div>
          )}

          {/* Error */}
          {status === 'error' && errorMsg && (
            <div style={{
              padding: '0.75rem',
              borderRadius: '8px',
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#f87171',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.5rem'
            }}>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Prompt Editor UI when status is 'prompt_edit' */}
          {status === 'prompt_edit' && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              padding: '1rem',
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '8px',
              border: '1px solid var(--border-color)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f59e0b' }}>
                <AlertCircle size={18} style={{ flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>内容合规安全拦截编辑</span>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                当前拦截阶段为：<strong>{failedPromptContext?.phase === 1 ? 'Phase 1: 章节大纲划分' : `Phase 2: 第 ${(failedPromptContext?.chapterIndex ?? 0) + 1} 章小说创作`}</strong>。
                LLM 检测到当前 Prompt 中可能包含敏感、违规或不合规的词汇，因此拦截了该请求。
                请您在下方修改 Prompt 模板（例如剔除敏感字眼、降低尺度或重写引导语），然后点击手动重试。
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                  System Prompt (系统提示词):
                </label>
                <textarea
                  value={editableSystemPrompt}
                  onChange={e => setEditableSystemPrompt(e.target.value)}
                  style={{
                    width: '100%',
                    height: '100px',
                    fontSize: '0.8rem',
                    fontFamily: 'monospace',
                    padding: '0.5rem',
                    backgroundColor: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    resize: 'vertical'
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                  User Prompt (用户输入内容):
                </label>
                <textarea
                  value={editableUserPrompt}
                  onChange={e => setEditableUserPrompt(e.target.value)}
                  style={{
                    width: '100%',
                    height: '180px',
                    fontSize: '0.8rem',
                    fontFamily: 'monospace',
                    padding: '0.5rem',
                    backgroundColor: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    resize: 'vertical'
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.75rem',
          paddingTop: '1rem',
          borderTop: '1px solid var(--border-color)',
          marginTop: '1rem'
        }}>
          {status === 'preview' && (
            <>
              <button
                onClick={() => {
                  setStatus('idle')
                  setScrapedData(null)
                  setChapterPlan(null)
                }}
                className="btn-secondary"
                type="button"
                style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
              >
                重新输入
              </button>
              <button
                onClick={handleStartGeneration}
                className="btn-primary"
                type="button"
                style={{
                  padding: '0.5rem 1.5rem',
                  fontSize: '0.85rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}
              >
                <Sparkles size={14} />
                开始生成小说
              </button>
            </>
          )}

          {(status === 'analyzing' || status === 'generating') && (
            <button
              onClick={() => {
                if (abortControllerRef.current) {
                  abortControllerRef.current.abort()
                }
                setStatus('preview')
                setProgress('已取消')
              }}
              className="btn-secondary"
              type="button"
              style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', color: '#ef4444' }}
            >
              取消生成
            </button>
          )}

          {status === 'done' && (
            <button
              onClick={handleClose}
              className="btn-primary"
              type="button"
              style={{ padding: '0.5rem 1.5rem', fontSize: '0.85rem' }}
            >
              完成
            </button>
          )}

          {(status === 'idle' || status === 'error') && (
            <button
              onClick={handleClose}
              className="btn-secondary"
              type="button"
              style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
            >
              取消
            </button>
          )}

          {status === 'prompt_edit' && (
            <>
              {generatedChapters.length > 0 && (
                <button
                  onClick={handleSaveAndExit}
                  className="btn-secondary"
                  type="button"
                  style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', color: '#10b981', borderColor: '#10b981' }}
                >
                  保留已生成并退出
                </button>
              )}
              <button
                onClick={handleClose}
                className="btn-secondary"
                type="button"
                style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
              >
                取消
              </button>
              <button
                onClick={handleManualRetry}
                className="btn-primary"
                type="button"
                style={{
                  padding: '0.5rem 1.5rem',
                  fontSize: '0.85rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}
              >
                <Sparkles size={14} />
                手动重试
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
