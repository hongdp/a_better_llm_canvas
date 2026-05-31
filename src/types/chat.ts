export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[] // base64 Data URLs ("data:image/...;base64,...")
  timestamp: string
  provider?: string
  model?: string
}
