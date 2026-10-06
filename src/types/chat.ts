/** One chapter a turn wrote to — a row of the bubble's "changed this turn" block (spec D2). */
export interface AgentTouchedChapter {
  documentId: string
  /** The title when the turn ran; shown if the chapter is renamed or deleted later. */
  titleAtRun: string
  kind: 'edits' | 'rewrite' | 'selection' | 'created' | 'polished'
  /** Changes that landed (edit blocks, or 1 for a rewrite/selection). */
  changes: number
  /** Changes that could not be located. */
  failed: number
}

/**
 * What an agentic turn did, kept on its assistant bubble (spec §5.6). Trace
 * lines and counts only — never chapter text. A chapter's review status is
 * NOT stored: it is read from the chapter's live content, so it cannot go
 * stale after an accept or reject.
 */
/** One entry of a turn as it happened: a step's chat text, or a call it made. */
export type AgentTimelineItem =
  | { type: 'text'; text: string }
  | { type: 'tool'; line: string; ok: boolean }

export interface AgentTurnRecord {
  status: 'running' | 'done' | 'stopped' | 'step_limit'
  steps: number
  /** One line per executed tool call, in order. */
  trace: string[]
  touched: AgentTouchedChapter[]
  /**
   * The turn in order — each step's text, then the calls that step made — so
   * the bubble shows tool use where it happened, not in a list at the end.
   * `content` still holds the joined text (history, older clients).
   */
  timeline?: AgentTimelineItem[]
  /** Bubble text before the timeline (the attached-context label). */
  prefix?: string
  /** Bubble text after it (completion warnings, the step-limit note). */
  suffix?: string
  /** While running: the step in flight (its text so far, a progress line). */
  live?: string
}

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
  /** Assistant only: what an agentic turn read and changed. */
  agent?: AgentTurnRecord
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
