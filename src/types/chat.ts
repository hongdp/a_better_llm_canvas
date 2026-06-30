export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[] // base64 Data URLs ("data:image/...;base64,...")
  timestamp: string
  provider?: string
  model?: string
  /** Roleplay message subtype for special rendering in RP mode */
  rpType?: 'narration' | 'action' | 'system_event' | 'choice'
  /** Clickable choice options presented by the GM (when rpType === 'choice') */
  rpChoices?: string[]
}

export interface RoleplayConfig {
  characterName: string
  genre: string
  difficulty: 'easy' | 'normal' | 'hard'
  storyLoreDocId: string
  gameStateDocId: string
  customWorldDesc?: string
  isInitialized: boolean
}
