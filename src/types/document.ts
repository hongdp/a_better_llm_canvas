export interface CanvasDocument {
  id: string
  title: string
  content: string
  contentLoaded?: boolean
  selectedReferenceIds?: string[]
  createdAt: string
  updatedAt: string
}

export interface DocumentVersion {
  id: string
  documentId: string
  timestamp: string
  title: string
  content: string
}
