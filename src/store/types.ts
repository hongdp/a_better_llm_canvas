/**
 * Shared store-internal types. AppState is the intersection of the slice
 * interfaces; slices import it TYPE-ONLY from here so no value-level import
 * cycle exists between the slice modules and the combined store.
 */
import type { DocumentsSlice } from './slices/documentsSlice'
import type { VersionsSlice } from './slices/versionsSlice'
import type { ChatSlice } from './slices/chatSlice'
import type { SettingsSlice } from './slices/settingsSlice'
import type { UiSlice } from './slices/uiSlice'
import type { BooksSlice } from './slices/booksSlice'
import type { AuthSlice } from './slices/authSlice'

export type AppState = DocumentsSlice &
  VersionsSlice &
  ChatSlice &
  SettingsSlice &
  UiSlice &
  BooksSlice &
  AuthSlice

// Minimal shapes of the document/version metadata returned by the books API
// (content is omitted server-side and lazy-loaded on demand).
export interface ServerDocumentMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  summary?: string | null
  summaryContentHash?: string | null
}

export interface ServerVersionMeta {
  id: string
  documentId: string
  title: string
  timestamp: string
}
