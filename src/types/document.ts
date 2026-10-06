export interface CanvasDocument {
  id: string
  title: string
  content: string
  contentLoaded?: boolean
  createdAt: string
  updatedAt: string
  /**
   * LLM-generated short summary (~120 words + key entities) used for the
   * always-on chapter index and context auto-selection. Navigation metadata,
   * not a source of truth — may lag behind `content` (see summaryContentHash).
   */
  summary?: string
  /** Hash of `content` at the time `summary` was generated. Mismatch = stale. */
  summaryContentHash?: string
}

export interface DocumentVersion {
  id: string
  documentId: string
  /**
   * Which book the snapshot belongs to. Optional because snapshots taken
   * before version history became per-book have none — those are attributed to
   * whichever book is open when they are next counted.
   */
  bookId?: string
  timestamp: string
  title: string
  content: string
}
