import React, { useState, useRef, useEffect } from 'react'
import { Globe, X, RefreshCw, Sparkles, CheckCircle, AlertCircle } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { streamLLM } from '../services/llm'
import type { LLMMessage } from '../types/llm'
import type { ScrapedData, ChapterPlan, GeneratedChapter, FailedPromptContext } from '../types/import'
import { preprocessScrapedData, getImageDimensions } from '../services/import/imageProcessor'
import { parseHtmlToScrapedData } from '../services/import/parser'
import {
  isSafetyError,
  censorSensitiveText,
  buildInterleavedContent,
  buildChapterInterleavedContent,
  getPreviousChapterEnding,
  buildOutlineAndChapterDocs
} from '../services/import/contentBuilder'
import { errorMessage } from '../services/import/errors'
import type { EnrichedImportError } from '../services/import/errors'
import { fetchScrapedDataFromUrl, uploadScrapedHtmlFile, readFileAsText } from '../services/import/scraper'
import {
  buildPhase1Prompts,
  buildNextChapterOutline,
  buildPhase2ChapterPrompts,
  buildImageAnalysisPrompts
} from '../services/import/prompts'
import {
  parseChapterPlanResponse,
  parseGeneratedChapterResponse,
  parseImageDescriptionsResponse
} from '../services/import/responseParsers'
import { flagUnsupportedVisionImages } from '../services/import/visionFilter'
import type { ImportStatus } from './import/types'
import { ImportSourceInput } from './import/ImportSourceInput'
import { ScrapePreviewPanel } from './import/ScrapePreviewPanel'
import { ChapterPlanPanel } from './import/ChapterPlanPanel'
import { PromptEditorPanel } from './import/PromptEditorPanel'
import { ImportModalFooter } from './import/ImportModalFooter'

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
  const [selectedImageIndices, setSelectedImageIndices] = useState<number[]>([])
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
    setSelectedImageIndices([])
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

  // Step 1: Fetch URL content from backend
  const handleFetch = async () => {
    if (!url.trim()) return

    setStatus('fetching')
    setProgress('正在抓取网页内容...')
    setErrorMsg('')

    try {
      const data = await fetchScrapedDataFromUrl(url.trim())

      if (data.totalParagraphs === 0) {
        throw new Error('未能从该页面提取到任何文字内容。')
      }

      const processedData = await preprocessScrapedData(data)
      setScrapedData(processedData)
      setSelectedImageIndices(processedData.images.map(img => img.index))
      setStatus('preview')
      setProgress('')
    } catch (err) {
      setStatus('error')
      setErrorMsg(errorMessage(err) || '抓取失败')
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
        data = await uploadScrapedHtmlFile(file)
      } else {
        // For small files (< 5MB), parse client-side to save bandwidth
        setProgress('正在读取本地网页文件...')
        const text = await readFileAsText(file)

        setProgress('正在解析网页结构...')
        data = await parseHtmlToScrapedData(text, file.name)
      }

      if (data.totalParagraphs === 0) {
        throw new Error('未能从该本地 HTML 文件中提取到任何文字内容。')
      }

      const processedData = await preprocessScrapedData(data)
      setScrapedData(processedData)
      setSelectedImageIndices(processedData.images.map(img => img.index))
      setStatus('preview')
      setProgress('')
    } catch (err) {
      setStatus('error')
      setErrorMsg(errorMessage(err) || '读取或解析本地网页失败')
    } finally {
      if (localFileInputRef.current) {
        localFileInputRef.current.value = ''
      }
    }
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

      const { systemPrompt, userPrompt } = buildPhase1Prompts({
        data,
        interleavedContent,
        userCustomPrompt,
        censored
      })

      const config = getActiveConfig()

      return new Promise<ChapterPlan>((resolve, reject) => {
        abortControllerRef.current = new AbortController()

        streamLLM(
          [systemPrompt, userPrompt],
          { ...config, signal: abortControllerRef.current.signal },
          {
            onChunk: () => { /* progress is only reported once the full plan arrives */ },
            onDone: (fullText: string) => {
              try {
                const plan = parseChapterPlanResponse(fullText)
                setChapterPlan(plan)
                resolve(plan)
              } catch (e) {
                reject(e)
              }
            },
            onError: (err: Error) => {
              const enrichedErr = err as EnrichedImportError
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
    } catch (err) {
      if (isSafetyError(err)) {
        console.warn('Phase 1 failed due to safety guidelines. Retrying with censored content...', err)
        setProgress('Phase 1 (安全重试): 发现内容敏感，正在对关键词进行本地脱敏后重新规划章节...')
        try {
          return await doAnalysisAttempt(true)
        } catch (censoredErr) {
          if (isSafetyError(censoredErr)) {
            const enriched = censoredErr as EnrichedImportError
            enriched.isSafetyPromptContext = true
            enriched.phase = 1
          }
          throw censoredErr
        }
      }
      throw err
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
      const nextChPlan = plan.chapters[i + 1]
      const nextChapterOutline = buildNextChapterOutline(nextChPlan)
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
          let currentInterleavedContent = buildChapterInterleavedContent(data, chPlan.paragraphRange)

          if (attempt >= 2) {
            // Attempt 2: Strip all base64 images and simplify alt texts
            currentImages = []
            currentImageDescriptions = chImages.map(img => `- IMG-${img.index}: （配图已脱敏）`).join('\n')
            const cleanData = {
              ...data,
              images: data.images.map(img => ({ ...img, alt: '（配图已脱敏）' }))
            }
            currentInterleavedContent = buildChapterInterleavedContent(cleanData, chPlan.paragraphRange)
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
            currentInterleavedContent = buildChapterInterleavedContent(censoredData, chPlan.paragraphRange)
            currentInterleavedContent = buildChapterInterleavedContent(censoredData, chPlan.paragraphRange)
          }

          const prompts = buildPhase2ChapterPrompts({
            plan,
            chPlan,
            userCustomPrompt,
            prevEnding,
            nextChapterOutline,
            imageDescriptions: currentImageDescriptions,
            interleavedContent: currentInterleavedContent,
            imageBase64s: currentImages.map(img => img.base64)
          })
          systemPrompt = prompts.systemPrompt
          userPrompt = prompts.userPrompt

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
                    resolve(parseGeneratedChapterResponse(fullText, chPlan.chapterNumber))
                  } catch (e) {
                    reject(e)
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

        } catch (err) {
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
              const enriched = err as EnrichedImportError
              enriched.isSafetyPromptContext = true
              enriched.phase = 2
              enriched.systemPrompt = systemPrompt
              enriched.userPrompt = userPrompt
              enriched.chapterIndex = i
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



  // Phase 0: Use LLM vision to analyze and describe images
  const analyzeImages = async (data: ScrapedData): Promise<ScrapedData> => {
    // 1. Initial quick MIME and length filter, and flag unsuitable ones immediately
    const updatedImages = flagUnsupportedVisionImages(data.images)

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
      const { systemPrompt, userPrompt } = buildImageAnalysisPrompts(img, imageAnalysisPrompt)

      const config = getActiveConfig()

      try {
        const descriptions = await new Promise<{ index: number | string; description: string }[]>((resolve, reject) => {
          streamLLM(
            [systemPrompt, userPrompt],
            { ...config, signal },
            {
              onChunk: () => { /* descriptions are only parsed once the full response arrives */ },
              onDone: (fullText: string) => {
                try {
                  resolve(parseImageDescriptionsResponse(fullText))
                } catch (e) {
                  reject(e)
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

      } catch (err) {
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
    const executing: Promise<void>[] = []
    const results: Promise<void>[] = []

    for (const img of validImages) {
      const p = processImage(img)
      results.push(p)
      if (concurrencyLimit < validImages.length) {
        const e: Promise<void> = p.then(() => {
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
    const allDocs = buildOutlineAndChapterDocs(enrichedData, plan, chapters, partial)
    importAllDocuments(allDocs)
    setBookTitle((plan.bookTitle || enrichedData.title) + (partial ? ' (部分生成)' : ''))
  }

  // Handles pipeline errors, including safety blocks and cancellations
  const handlePipelineError = (
    rawErr: unknown,
    context: {
      enrichedData: ScrapedData
      plan?: ChapterPlan
      chapterIndex?: number
      generatedChapters: GeneratedChapter[]
    }
  ) => {
    const err = rawErr as EnrichedImportError
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
            setErrorMsg(`生成中断。已为您导入前 ${context.generatedChapters.length} 个生成的章节（含大纲）。错误原因: ${err.message || String(rawErr)}`)
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
    } catch (err) {
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
          streamLLM(
            [sysMsg, userMsg],
            { ...config, signal },
            {
              onChunk: () => { /* progress is only reported once the full plan arrives */ },
              onDone: (fullText: string) => {
                try {
                  const parsedPlan = parseChapterPlanResponse(fullText)
                  setChapterPlan(parsedPlan)
                  resolve(parsedPlan)
                } catch (e) {
                  reject(e)
                }
              },
              onError: (err: Error) => {
                const enrichedErr = err as EnrichedImportError
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
                  resolve(parseGeneratedChapterResponse(fullText, failedChapterPlan.chapterNumber))
                } catch (e) {
                  reject(e)
                }
              },
              onError: (err: Error) => {
                const enrichedErr = err as EnrichedImportError
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
    } catch (err) {
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
      const dataToProcess = {
        ...scrapedData,
        images: scrapedData.images.filter(img => selectedImageIndices.includes(img.index))
      }
      enrichedData = await analyzeImages(dataToProcess)

      // Phase 1: Analysis
      const plan = await runPhase1(enrichedData)

      // Phase 2: Generation and import
      await executePhase2AndImport(enrichedData, plan, 0, [])
    } catch (err) {
      handlePipelineError(err, {
        enrichedData: enrichedData || scrapedData,
        generatedChapters: []
      })
    }
  }

  if (!isOpen) return null

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
            <ImportSourceInput
              url={url}
              onUrlChange={setUrl}
              status={status}
              onFetch={handleFetch}
              onLocalFileChange={handleLocalFileChange}
              localFileInputRef={localFileInputRef}
            />
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
            <ScrapePreviewPanel
              scrapedData={scrapedData}
              status={status}
              selectedImageIndices={selectedImageIndices}
              setSelectedImageIndices={setSelectedImageIndices}
              analyzedIndices={analyzedIndices}
            />
          )}

          {/* Chapter Plan Preview */}
          {chapterPlan && (status === 'analyzing' || status === 'generating' || status === 'done') && (
            <ChapterPlanPanel
              chapterPlan={chapterPlan}
              generatedChapters={generatedChapters}
            />
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
            <PromptEditorPanel
              failedPromptContext={failedPromptContext}
              editableSystemPrompt={editableSystemPrompt}
              onSystemPromptChange={setEditableSystemPrompt}
              editableUserPrompt={editableUserPrompt}
              onUserPromptChange={setEditableUserPrompt}
            />
          )}
        </div>

        {/* Footer buttons */}
        <ImportModalFooter
          status={status}
          hasGeneratedChapters={generatedChapters.length > 0}
          onReset={() => {
            setStatus('idle')
            setScrapedData(null)
            setChapterPlan(null)
          }}
          onStartGeneration={handleStartGeneration}
          onCancelGeneration={() => {
            if (abortControllerRef.current) {
              abortControllerRef.current.abort()
            }
            setStatus('preview')
            setProgress('已取消')
          }}
          onClose={handleClose}
          onSaveAndExit={handleSaveAndExit}
          onManualRetry={handleManualRetry}
        />
      </div>
    </div>
  )
}
