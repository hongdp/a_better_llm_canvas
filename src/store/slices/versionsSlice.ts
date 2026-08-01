import type { StateCreator } from 'zustand'
import type { DocumentVersion } from '../../types/document'
import type { AppState } from '../types'
import { safeIndexedDBSet, saveDocumentsToIndexedDB } from '../persistence'

export interface VersionsSlice {
  // Version history state
  versions: DocumentVersion[]
  createVersionSnapshot: (title?: string) => void
  restoreVersion: (versionId: string) => void
  deleteVersionSnapshot: (versionId: string) => void
}

export const createVersionsSlice: StateCreator<AppState, [], [], VersionsSlice> = (set) => ({
  // Version history state
  versions: [],

  createVersionSnapshot: (title = 'Manual Snapshot') => {
    set((state) => {
      const activeDoc = state.documents.find(d => d.id === state.activeDocumentId)
      if (!activeDoc) return {}

      const newVersion: DocumentVersion = {
        id: `ver-${Date.now()}`,
        documentId: state.activeDocumentId,
        timestamp: new Date().toISOString(),
        title,
        content: activeDoc.content,
      }

      let updatedVersions = [newVersion, ...state.versions]
      if (updatedVersions.length > 50) {
        updatedVersions = updatedVersions.slice(0, 50)
      }

      safeIndexedDBSet('web_canvas_versions', updatedVersions)
      return { versions: updatedVersions }
    })
  },

  restoreVersion: (versionId) => {
    set((state) => {
      const version = state.versions.find(v => v.id === versionId)
      if (!version) return {}

      // Create an undo snapshot first
      const activeDoc = state.documents.find(d => d.id === state.activeDocumentId)
      let updatedVersions = state.versions
      if (activeDoc) {
        const preRestoreVersion: DocumentVersion = {
          id: `ver-${Date.now()}`,
          documentId: state.activeDocumentId,
          timestamp: new Date().toISOString(),
          title: `Auto-save before restoring "${version.title}"`,
          content: activeDoc.content,
        }
        updatedVersions = [preRestoreVersion, ...state.versions]
        if (updatedVersions.length > 50) {
          updatedVersions = updatedVersions.slice(0, 50)
        }
        safeIndexedDBSet('web_canvas_versions', updatedVersions)
      }

      const updatedDocs = state.documents.map((d) => {
        if (d.id === state.activeDocumentId) {
          return {
            ...d,
            content: version.content,
            updatedAt: new Date().toISOString(),
          }
        }
        return d
      })
      saveDocumentsToIndexedDB(updatedDocs, true)

      return {
        documents: updatedDocs,
        versions: updatedVersions
      }
    })
  },

  deleteVersionSnapshot: (versionId) => {
    set((state) => {
      const filteredVersions = state.versions.filter(v => v.id !== versionId)
      safeIndexedDBSet('web_canvas_versions', filteredVersions)
      return { versions: filteredVersions }
    })
  },
})
