/**
 * Default constants for the app store: provider configs, mock documents,
 * system prompt presets, and image pipeline defaults. Pure data — no side
 * effects — so any store module can import it without cycle concerns.
 */
import type { LLMProvider, ImageGenConfig, ProviderConfig, SystemPromptTemplate } from '../types/llm'
import type { CanvasDocument } from '../types/document'

export const DEFAULT_CONFIGS: Record<LLMProvider, ProviderConfig> = {
  openai: {
    apiKey: import.meta.env.VITE_OPENAI_API_KEY || '',
    model: import.meta.env.VITE_OPENAI_MODEL || 'gpt-4o',
    baseUrl: import.meta.env.VITE_OPENAI_BASE_URL || 'https://api.openai.com/v1',
    maxOutputTokens: 16384,
  },
  gemini: {
    apiKey: import.meta.env.VITE_GEMINI_API_KEY || '',
    model: import.meta.env.VITE_GEMINI_MODEL || 'gemini-1.5-pro',
    baseUrl: import.meta.env.VITE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    geminiSafetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
    maxOutputTokens: 16384,
  },
  anthropic: {
    apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY || '',
    model: import.meta.env.VITE_ANTHROPIC_MODEL || 'claude-3-5-sonnet',
    baseUrl: import.meta.env.VITE_ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
    maxOutputTokens: 16384,
  },
  ollama: {
    apiKey: import.meta.env.VITE_OLLAMA_API_KEY || 'ollama-no-key',
    model: import.meta.env.VITE_OLLAMA_MODEL || 'llama3',
    baseUrl: import.meta.env.VITE_OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    maxOutputTokens: 16384,
  },
  grok: {
    apiKey: import.meta.env.VITE_GROK_API_KEY || '',
    model: import.meta.env.VITE_GROK_MODEL || 'grok-3',
    baseUrl: import.meta.env.VITE_GROK_BASE_URL || 'https://api.x.ai/v1',
    maxOutputTokens: 16384,
  },
}


export const MOCK_DOCUMENTS: CanvasDocument[] = [
  {
    id: 'doc-1',
    title: 'Chapter 1: Introduction',
    content: `<h1>Getting Started with Web Canvas</h1>
<p>Welcome to <strong>Web Canvas</strong>! This is an LLM-powered environment designed for writing and document collaboration.</p>
<p>You can manage your chapters in the Chapters Sidebar on the left-most side of the screen.</p>
<p>Toggle references using the tags below the chat box to include other chapters in Gemini's context!</p>`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'doc-2',
    title: 'Chapter 2: Setup Guide',
    content: `<h1>Setup and Config</h1>
<p>This is Chapter 2. You can toggle it as a reference under the chat box so that Gemini can see its content while you edit another chapter.</p>
<p>Make sure to enter your API key in the settings panel first.</p>`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

export const DEFAULT_SYSTEM_PROMPTS: SystemPromptTemplate[] = [
  {
    id: 'prompt-none',
    name: 'General Assistant',
    content: '',
  },
  {
    id: 'prompt-academic',
    name: 'Academic Style',
    content: 'Write in a highly academic, formal, and rigorous tone. Use precise terminology and passive voice where appropriate for scientific style.',
  },
  {
    id: 'prompt-concise',
    name: 'Concise Editor',
    content: 'Be extremely concise. Eliminate all unnecessary words, explanations, and redundant sentences. Focus on high information density.',
  },
  {
    id: 'prompt-creative',
    name: 'Creative Storyteller',
    content: 'Emphasize narrative flow, engaging vocabulary, sensory details, and vivid imagery. Adapt tone to be highly expressive.',
  }
]

export const DEFAULT_IMAGE_ANALYSIS_PROMPT = `你是一位专业的图片描述专家，擅长描写人物细节。请仔细观察提供的图片，重点关注图片中的人物，写一段详细的中文描述。

要求（按优先级）：
1. **人物（最重要）**：若图片中有人，重点描写：
   - 外貌特征：年龄感、发型发色、五官、肤色、体型等
   - 身体部位：尽量描写可见的身体部位，如：手（手势、指甲）、手臂（是否裸露、肌肉感）、腿（长度感、裤腿/裙摆覆盖情况）、脚（鞋子款式）、肩部、颈部、腰部等，结合姿势描写
   - 穿着打扮：服装款式、颜色、风格（如休闲、正式、时尚等）、配饰
   - 姿势与位置：站姿、坐姿、动作、在画面中的位置（左/右/中/前/后）
   - 表情与神态：喜悦、严肃、自然等
   - 若有多人，分别描写每个人的特征及相互关系/位置关系
2. **场景与环境**：简要描述背景、地点、氛围等
3. 使用中文描述，长度在 100-250 字之间
4. 输出严格的 JSON 格式，不要有任何其他文字

JSON格式：
{
  "descriptions": [
    {"index": {{index}}, "description": "图片描述内容..."}
  ]
}`

export const DEFAULT_IMAGE_GEN_CONFIG: ImageGenConfig = {
  provider: 'openai',
  apiKey: import.meta.env.VITE_OPENAI_API_KEY || '',
  model: 'dall-e-3',
  baseUrl: '',
  styleSystemPrompt: '',       // empty = use DEFAULT_IMAGE_STYLE_SYSTEM_PROMPT from imageGen.ts
  llmEnhancementEnabled: true, // enhance prompts with LLM by default
}
