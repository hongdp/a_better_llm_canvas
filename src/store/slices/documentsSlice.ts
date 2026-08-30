import type { StateCreator } from 'zustand'
import type { CanvasDocument } from '../../types/document'
import type { AppState } from '../types'
import { localStorage, saveDocumentsToIndexedDB, loadWholeBookMode, saveWholeBookMode } from '../persistence'
import { idsNeedingContent, loadDocumentContents } from '../contentLoader'
import { MOCK_DOCUMENTS } from '../defaults'
import { loadSavedActiveDocId } from '../settingsPersistence'
// Benign import cycle: this module only references useAppStore inside action
// bodies, which run long after both modules have finished evaluating.
import { useAppStore } from '../useAppStore'

/**
 * "Nothing there" as the editor writes it: an empty string, or the empty
 * paragraph ProseMirror keeps because a document must contain one block.
 */
export function isBlankContent(html: string): boolean {
  // Media carries no text but is very much content — a chapter holding only a
  // generated illustration must not read as empty to the guard below.
  if (/<(img|video|audio|iframe)\b/i.test(html)) return false
  return !html.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '')
}

export interface DocumentsSlice {
  // Multi-document state
  documents: CanvasDocument[]
  activeDocumentId: string
  // Reference selection for the ACTIVE document (mirrors of its per-doc
  // fields): pins always attach and stick across turns; blocked chapters are
  // never auto-attached. Auto-selected ids are ephemeral (computed at send
  // time by utils/contextSelection) and never stored.
  pinnedReferenceIds: string[]
  blockedReferenceIds: string[]
  // Whole-book mode ("All chapters" super-tag). One-shot by design: it
  // auto-resets after a send so the entire book isn't re-billed every turn.
  // Deliberately NOT persisted.
  // 'once' auto-resets after a send (the default click); 'sticky' keeps the
  // whole book attached across turns, moving it into the stable prompt
  // prefix so turns 2+ pay cache-read prices. Deliberately NOT persisted.
  wholeBookMode: 'off' | 'once' | 'sticky'
  setWholeBookMode: (mode: 'off' | 'once' | 'sticky') => void

  setActiveDocumentId: (id: string) => void
  addDocument: (title?: string, content?: string) => string
  importAllDocuments: (docs: { title: string; content: string }[]) => void
  reorderDocuments: (newDocs: CanvasDocument[]) => void
  deleteDocument: (id: string) => void
  updateDocument: (id: string, updates: Partial<CanvasDocument>) => void
  updateActiveDocument: (updates: Partial<CanvasDocument>) => void
  setDocumentSummary: (id: string, summary: string, contentHash: string) => void
  /** Cycle a chapter's manual reference state: neutral → pinned → blocked → neutral. */
  cycleReferenceState: (id: string) => void
  clearReferences: () => void
  /**
   * Ensure the given documents' content is loaded (server books lazy-load
   * metadata-only chapters). Resolves once every needed fetch settles; a
   * failed doc stays unloaded and degrades to its index line. Callers that
   * attach chapter content (pins, whole-book) MUST await this
   * first, or unopened chapters are silently dropped by the selector.
   */
  ensureDocumentContents: (ids: string[]) => Promise<void>
}

export const createDocumentsSlice: StateCreator<AppState, [], [], DocumentsSlice> = (set) => {
  const initialDocs = MOCK_DOCUMENTS
  const initialActiveId = loadSavedActiveDocId(initialDocs)

  return {
    // Multi-document state
    documents: initialDocs,
    activeDocumentId: initialActiveId,
    pinnedReferenceIds: initialDocs.find(d => d.id === initialActiveId)?.pinnedReferenceIds || [],
    blockedReferenceIds: initialDocs.find(d => d.id === initialActiveId)?.blockedReferenceIds || [],
    // Sticky is a standing choice and survives reloads; 'once' is consumed by
    // the next send, so it is never restored (see persistence.loadWholeBookMode).
    wholeBookMode: loadWholeBookMode(),
    setWholeBookMode: (mode) => {
      saveWholeBookMode(mode)
      set({ wholeBookMode: mode })
    },

    setActiveDocumentId: (id) => {
      localStorage.setItem('web_canvas_active_document_id', id)
      set((state) => {
        const targetDoc = state.documents.find((d) => d.id === id)
        return {
          activeDocumentId: id,
          pinnedReferenceIds: (targetDoc?.pinnedReferenceIds || []).filter(refId => refId !== id),
          blockedReferenceIds: (targetDoc?.blockedReferenceIds || []).filter(refId => refId !== id)
        }
      })

      // Lazy-load document content from server if not yet loaded
      void useAppStore.getState().ensureDocumentContents([id])
    },

    ensureDocumentContents: async (ids) => {
      const state = useAppStore.getState()
      if (!state.user || !state.activeBookId) return
      const needed = idsNeedingContent(ids, state.documents)
      if (needed.length === 0) return
      await loadDocumentContents(state.activeBookId, needed, {
        onLoaded: (id, content) => {
          useAppStore.setState((s) => ({
            documents: s.documents.map(d =>
              d.id === id ? { ...d, content, contentLoaded: true } : d
            )
          }))
          // Update local cache
          saveDocumentsToIndexedDB(useAppStore.getState().documents, true)
        }
      })
    },

    addDocument: (title = 'New Chapter', content = '<p>Start writing...</p>') => {
      const newDoc: CanvasDocument = {
        id: `doc-${Date.now()}`,
        title,
        content,
        contentLoaded: true,
        pinnedReferenceIds: [],
        blockedReferenceIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      let docId = ''

      set((state) => {
        const updatedDocs = [...state.documents, newDoc]
        saveDocumentsToIndexedDB(updatedDocs, true)
        localStorage.setItem('web_canvas_active_document_id', newDoc.id)
        docId = newDoc.id
        return {
          documents: updatedDocs,
          activeDocumentId: newDoc.id,
          pinnedReferenceIds: [],
          blockedReferenceIds: []
        }
      })

      // Sync new document to server
      const state = useAppStore.getState()
      if (state.user && state.activeBookId) {
        fetch(`/api/books/${state.activeBookId}/documents`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': state.csrfToken || ''
          },
          body: JSON.stringify({
            documents: [{ id: newDoc.id, title: newDoc.title, content: newDoc.content, createdAt: newDoc.createdAt, updatedAt: newDoc.updatedAt }]
          })
        }).catch(e => console.error('Failed to sync new document to server', e))
      }

      return docId
    },

    importAllDocuments: (newDocs) => {
      if (newDocs.length === 0) return

      const formattedDocs: CanvasDocument[] = newDocs.map((doc, idx) => ({
        id: `doc-${Date.now()}-${idx}`,
        title: doc.title || `Chapter ${idx + 1}`,
        content: doc.content || '<p></p>',
        contentLoaded: true,
        pinnedReferenceIds: [],
        blockedReferenceIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }))

      set(() => {
        saveDocumentsToIndexedDB(formattedDocs, true)
        localStorage.setItem('web_canvas_active_document_id', formattedDocs[0].id)
        return {
          documents: formattedDocs,
          activeDocumentId: formattedDocs[0].id,
          pinnedReferenceIds: [],
          blockedReferenceIds: []
        }
      })
    },

    reorderDocuments: (newDocs) => {
      set(() => {
        saveDocumentsToIndexedDB(newDocs, true)
        return { documents: newDocs }
      })

      // Persist document order to server
      const state = useAppStore.getState()
      if (state.user && state.activeBookId) {
        const docIds = newDocs.map(d => d.id)
        fetch(`/api/books/${state.activeBookId}/documents/reorder`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': state.csrfToken || ''
          },
          body: JSON.stringify({ documentIds: docIds })
        }).catch(e => console.error('Failed to persist document order', e))
      }
    },

    deleteDocument: (id) => {
      set((state) => {
        const filteredDocs = state.documents.filter((d) => d.id !== id)

        let newActiveId = state.activeDocumentId
        if (state.activeDocumentId === id) {
          newActiveId = filteredDocs[0]?.id || ''
        }

        // If all docs are deleted, add a fresh fallback doc
        if (filteredDocs.length === 0) {
          const fallbackDoc: CanvasDocument = {
            id: `doc-${Date.now()}`,
            title: 'Chapter 1: Welcome',
            content: '<h1>Getting Started</h1><p>Start writing...</p>',
            contentLoaded: true,
            pinnedReferenceIds: [],
            blockedReferenceIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          filteredDocs.push(fallbackDoc)
          newActiveId = fallbackDoc.id
        }

        saveDocumentsToIndexedDB(filteredDocs, true)
        localStorage.setItem('web_canvas_active_document_id', newActiveId)

        return {
          documents: filteredDocs,
          activeDocumentId: newActiveId,
          // Remove from manual reference lists if present
          pinnedReferenceIds: state.pinnedReferenceIds.filter((refId) => refId !== id),
          blockedReferenceIds: state.blockedReferenceIds.filter((refId) => refId !== id)
        }
      })

      // Sync deletion to server
      const state = useAppStore.getState()
      if (state.user && state.activeBookId) {
        fetch(`/api/books/${state.activeBookId}/documents/${id}`, {
          method: 'DELETE',
          headers: {
            'X-CSRF-Token': state.csrfToken || ''
          }
        }).catch(e => console.error('Failed to delete document on server', e))
      }
    },

    updateDocument: (id, updates) => {
      set((state) => {
        const updatedDocs = state.documents.map((d) => {
          if (d.id === id) {
            return {
              ...d,
              ...updates,
              updatedAt: new Date().toISOString(),
            }
          }
          return d
        })
        saveDocumentsToIndexedDB(updatedDocs, false)
        return { documents: updatedDocs }
      })
    },

    updateActiveDocument: (updates) => {
      set((state) => {
        const active = state.documents.find(d => d.id === state.activeDocumentId)

        /**
         * Problem: a chapter of prose was replaced with an empty document and
         *   auto-saved over, with no version snapshot to go back to.
         * Root cause: a completion path wrote back its "leave it as it was"
         *   base, and that base had been captured before the chapter's lazy
         *   content finished loading, so it was ''. The write itself looked
         *   exactly like a legitimate one.
         * Fix: blanking a non-empty chapter is never something the app does on
         *   its own — clearing a chapter is a user action, and it goes through
         *   the editor, which sends its own HTML rather than ''. So refuse the
         *   write here, where every path converges, instead of auditing each
         *   caller for a stale base. This is a backstop, not the cure: the
         *   caller that captured an empty base is fixed too (see the rejoin in
         *   useChatLLM), but the next one like it must not cost a chapter.
         */
        if (active && updates.content !== undefined && isBlankContent(updates.content) && !isBlankContent(active.content)) {
          console.error(
            '[documents] Refused to blank a non-empty chapter.',
            { documentId: active.id, hadChars: active.content.length }
          )
          return {}
        }

        const updatedDocs = state.documents.map((d) => {
          if (d.id === state.activeDocumentId) {
            return {
              ...d,
              ...updates,
              updatedAt: new Date().toISOString(),
            }
          }
          return d
        })
        saveDocumentsToIndexedDB(updatedDocs, false)
        return { documents: updatedDocs }
      })
    },

    setDocumentSummary: (id, summary, contentHash) => {
      // Deliberately does NOT bump updatedAt: a summary refresh is derived
      // metadata, not a user edit — bumping would churn server sync status
      // and re-mark the summary's own source content as newer than it.
      set((state) => {
        const updatedDocs = state.documents.map((d) =>
          d.id === id ? { ...d, summary, summaryContentHash: contentHash } : d
        )
        saveDocumentsToIndexedDB(updatedDocs, false)
        return { documents: updatedDocs }
      })

      // Fire-and-forget server sync (optimistic-UI convention: local state is
      // already updated; a failure just means the summary regenerates on the
      // next device instead of syncing).
      const state = useAppStore.getState()
      if (state.user && state.activeBookId) {
        fetch(`/api/books/${state.activeBookId}/documents/${id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': state.csrfToken || ''
          },
          body: JSON.stringify({ summary, summaryContentHash: contentHash })
        }).catch(e => console.error('Failed to sync document summary to server', e))
      }
    },

    cycleReferenceState: (id) => {
      set((state) => {
        // neutral → pinned → blocked → neutral. The UI's "auto" state is
        // ephemeral (scorer output) and behaves as neutral here: clicking an
        // auto tag promotes it to a sticky pin.
        let pinned = state.pinnedReferenceIds
        let blocked = state.blockedReferenceIds
        if (pinned.includes(id)) {
          pinned = pinned.filter((refId) => refId !== id)
          blocked = [...blocked, id]
        } else if (blocked.includes(id)) {
          blocked = blocked.filter((refId) => refId !== id)
        } else {
          pinned = [...pinned, id]
        }

        const updatedDocs = state.documents.map((d) => {
          if (d.id === state.activeDocumentId) {
            return {
              ...d,
              pinnedReferenceIds: pinned,
              blockedReferenceIds: blocked,
              updatedAt: new Date().toISOString(),
            }
          }
          return d
        })
        saveDocumentsToIndexedDB(updatedDocs, true)
        return {
          pinnedReferenceIds: pinned,
          blockedReferenceIds: blocked,
          documents: updatedDocs
        }
      })
      // Eagerly load a newly pinned chapter that only has server metadata so
      // the tag-bar preview/budget is accurate and send time doesn't wait.
      const after = useAppStore.getState()
      if (after.pinnedReferenceIds.includes(id)) {
        void after.ensureDocumentContents([id])
      }
    },

    clearReferences: () => {
      set((state) => {
        const updatedDocs = state.documents.map((d) => {
          if (d.id === state.activeDocumentId) {
            return {
              ...d,
              pinnedReferenceIds: [],
              blockedReferenceIds: [],
              updatedAt: new Date().toISOString(),
            }
          }
          return d
        })
        saveDocumentsToIndexedDB(updatedDocs, true)
        return {
          pinnedReferenceIds: [],
          blockedReferenceIds: [],
          documents: updatedDocs
        }
      })
    },
  }
}
