export interface ScrapedData {
  title: string
  paragraphs: { index: number; text: string; tag: string }[]
  images: { index: number; alt: string; base64: string; position: number; failedAnalysis?: boolean }[]
  totalParagraphs: number
  totalImages: number
}

export interface ChapterPlan {
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

export interface GeneratedChapter {
  chapterNumber: number
  title: string
  content: string
}

export interface FailedPromptContext {
  phase: 1 | 2
  enrichedData: ScrapedData
  plan?: ChapterPlan
  chapterIndex?: number
  generatedChapters?: GeneratedChapter[]
}
