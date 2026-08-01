/**
 * Server bootstrap and sync helpers: local IndexedDB bootstrap, background
 * session/book sync (initializeStoreFromServer), and the summary carry-over
 * rule shared with the books slice.
 *
 * NOTE on the import cycle: this module imports useAppStore from
 * './useAppStore' while useAppStore.ts (indirectly, via the slices)
 * re-imports this module. The cycle is benign because useAppStore is only
 * referenced inside function bodies, which run long after both modules have
 * finished evaluating (ESM live bindings resolve by then).
 */
import type { CanvasDocument, DocumentVersion } from '../types/document'
import type { AppState, ServerDocumentMeta, ServerVersionMeta } from './types'
import { localStorage, db, safeIndexedDBSet, saveDocumentsToIndexedDB, loadDocumentsFromIndexedDB } from './persistence'
import { MOCK_DOCUMENTS } from './defaults'
import { loadSavedConfigs, mergeProviderConfigs, saveConfigsToCookie, saveSystemPromptsToCookie } from './settingsPersistence'
import { getIsInitialized, setIsInitialized } from './syncRuntime'
import { useAppStore } from './useAppStore'

/**
 * Rebuilding the document list from server metadata would wipe client-side
 * fields the server doesn't round-trip. Summaries ARE server-synced now, so
 * a server value wins; the local one only fills gaps (e.g. generated while
 * logged out and not yet pushed). Pin/block reference lists remain
 * local-only and always carry over. Staleness is re-checked lazily against
 * content once it loads.
 */
export const carryOverLocalSummaries = (serverDocs: CanvasDocument[], prevDocs: CanvasDocument[]): CanvasDocument[] => {
  const prevById = new Map(prevDocs.map(d => [d.id, d]))
  return serverDocs.map(doc => {
    const prev = prevById.get(doc.id)
    if (!prev) return doc
    return {
      ...doc,
      ...(!doc.summary && prev.summary ? { summary: prev.summary, summaryContentHash: prev.summaryContentHash } : {}),
      ...(prev.pinnedReferenceIds ? { pinnedReferenceIds: prev.pinnedReferenceIds } : {}),
      ...(prev.blockedReferenceIds ? { blockedReferenceIds: prev.blockedReferenceIds } : {})
    }
  })
}

export const initializeStoreFromServer = async (forceRemoteSync = false) => {
  if (getIsInitialized() && !forceRemoteSync) return

  // 1. Load local state from IndexedDB first (fast, zero network overhead)
  if (!getIsInitialized()) {
    // Perform LocalStorage to IndexedDB migration if not done yet
    const isMigrated = localStorage.getItem('web_canvas_indexeddb_migrated') === 'true'
    if (!isMigrated) {
      try {
        const oldDocs = localStorage.getItem('web_canvas_documents')
        if (oldDocs) {
          await db.set('web_canvas_documents', JSON.parse(oldDocs))
          localStorage.removeItem('web_canvas_documents')
        }
        const oldVersions = localStorage.getItem('web_canvas_versions')
        if (oldVersions) {
          await db.set('web_canvas_versions', JSON.parse(oldVersions))
          localStorage.removeItem('web_canvas_versions')
        }
        localStorage.setItem('web_canvas_indexeddb_migrated', 'true')
        console.log('[Storage Migration] Successfully migrated heavy keys to IndexedDB.')
      } catch (migrationErr) {
        console.error('[Storage Migration] Migration failed:', migrationErr)
      }
    }

    // Load documents and versions from IndexedDB
    let loadedDocs: CanvasDocument[] | null = null
    let loadedVersions: DocumentVersion[] | null = null
    try {
      loadedDocs = await loadDocumentsFromIndexedDB()
      loadedVersions = await db.get<DocumentVersion[]>('web_canvas_versions')
    } catch (dbErr) {
      console.error('[IndexedDB] Failed to load data:', dbErr)
    }

    const documentsToSet = (loadedDocs && loadedDocs.length > 0) ? loadedDocs : MOCK_DOCUMENTS
    const versionsToSet = loadedVersions || []

    const activeLoadedDoc = documentsToSet.find(d => d.id === useAppStore.getState().activeDocumentId)
    useAppStore.setState({
      documents: documentsToSet,
      versions: versionsToSet,
      pinnedReferenceIds: activeLoadedDoc?.pinnedReferenceIds || [],
      blockedReferenceIds: activeLoadedDoc?.blockedReferenceIds || []
    })

    // Set isStoreInitialized immediately so the UI boots up instantly using offline/local cache
    useAppStore.setState({ isStoreInitialized: true })
    setIsInitialized(true)
  }

  const performSync = async () => {
    // 2. Fetch current session status in the background
    let loggedInUser: string | null = null
    try {
      const sessionRes = await fetch('/api/auth/session')
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json()
        const csrfToken: string | null = sessionData.csrfToken || null
        useAppStore.setState({ csrfToken })
        if (sessionData.loggedIn) {
          loggedInUser = sessionData.username
          useAppStore.setState({ user: { username: sessionData.username as string } })
        } else {
          useAppStore.setState({ user: null })
        }
      }
    } catch (e) {
      console.error('Session verification failed', e)
    }

    // 3. If not logged in, fetch available books list and stop here
    if (!loggedInUser) {
      await useAppStore.getState().fetchAvailableBooks()
      return
    }

    // 4. Continue initialization for logged-in user: fetch book state from server
    const activeBookId = localStorage.getItem('web_canvas_active_book_id') || 'default'

    useAppStore.setState({ serverSaveStatus: 'saving' })
    try {
      // Use new API that returns metadata + doc list (no content)
      const res = await fetch(`/api/books/${activeBookId}`)
      if (res.ok) {
        const serverData = await res.json()
        if (serverData && typeof serverData === 'object' && Object.keys(serverData).length > 0) {
          // Load server-side updates
          const updates: Partial<AppState> = {}

          // Build documents from metadata (without content — lazy-loaded)
          if (serverData.documents) {
            const docs: CanvasDocument[] = carryOverLocalSummaries(
              serverData.documents.map((d: ServerDocumentMeta) => ({
                id: d.id,
                title: d.title,
                content: '', // Will be lazy-loaded for active doc
                contentLoaded: false,
                createdAt: d.createdAt,
                updatedAt: d.updatedAt,
                summary: d.summary ?? undefined,
                summaryContentHash: d.summaryContentHash ?? undefined,
              })),
              useAppStore.getState().documents
            )
            updates.documents = docs
            saveDocumentsToIndexedDB(docs, true)
          }
          if (serverData.versions) {
            updates.versions = serverData.versions.map((v: ServerVersionMeta) => ({
              id: v.id,
              documentId: v.documentId,
              title: v.title,
              timestamp: v.timestamp,
              content: '', // Lazy-loaded on demand
            }))
            safeIndexedDBSet('web_canvas_versions', updates.versions)
          }
          if (serverData.bookTitle) {
            updates.bookTitle = serverData.bookTitle
            localStorage.setItem('web_canvas_book_title', serverData.bookTitle)
          }
          if (serverData.activeDocumentId) {
            updates.activeDocumentId = serverData.activeDocumentId
            localStorage.setItem('web_canvas_active_document_id', serverData.activeDocumentId)
          }
          if (serverData.activeProvider) {
            updates.activeProvider = serverData.activeProvider
            localStorage.setItem('web_canvas_active_provider', serverData.activeProvider)
          }
          if (serverData.providerConfigs) {
            const currentConfigs = useAppStore.getState().providerConfigs || loadSavedConfigs()
            const mergedConfigs = mergeProviderConfigs(currentConfigs, serverData.providerConfigs)
            updates.providerConfigs = mergedConfigs
            saveConfigsToCookie(mergedConfigs)
          }
          if (serverData.customSystemPrompts) {
            updates.customSystemPrompts = serverData.customSystemPrompts
            saveSystemPromptsToCookie(serverData.customSystemPrompts, serverData.activeSystemPromptId || 'prompt-none')
          }
          if (serverData.activeSystemPromptId) {
            updates.activeSystemPromptId = serverData.activeSystemPromptId
          }
          if (serverData.theme) {
            updates.theme = serverData.theme
            localStorage.setItem('web_canvas_theme', serverData.theme)
          }
          if (serverData.messages) updates.messages = serverData.messages
          if (serverData.debugMode !== undefined) {
            updates.debugMode = serverData.debugMode
            localStorage.setItem('web_canvas_debug_mode', String(serverData.debugMode))
          }

          useAppStore.setState({ ...updates, serverSaveStatus: 'saved', lastSyncedAt: new Date().toISOString() })

          // Lazy-load the active document's content
          const activeDocId = updates.activeDocumentId || serverData.activeDocumentId
          if (activeDocId) {
            try {
              const docRes = await fetch(`/api/books/${activeBookId}/documents/${activeDocId}`)
              if (docRes.ok) {
                const docData = await docRes.json()
                useAppStore.setState((s) => ({
                  documents: s.documents.map(d =>
                    d.id === activeDocId ? { ...d, content: docData.content, contentLoaded: true } : d
                  )
                }))
                saveDocumentsToIndexedDB(useAppStore.getState().documents, true)
              }
            } catch (e) {
              console.error('Failed to load active document content during init', e)
            }
          }
        } else {
          // Server is empty, initialize server with initial client/default state
          const state = useAppStore.getState()
          const postRes = await fetch('/api/books', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': state.csrfToken || ''
            },
            body: JSON.stringify({
              id: activeBookId,
              title: state.bookTitle,
              documents: state.documents.map(d => ({
                id: d.id,
                title: d.title,
                content: d.content,
                createdAt: d.createdAt,
                updatedAt: d.updatedAt,
              })),
              activeDocumentId: state.activeDocumentId,
              activeProvider: state.activeProvider,
              providerConfigs: state.providerConfigs,
              customSystemPrompts: state.customSystemPrompts,
              activeSystemPromptId: state.activeSystemPromptId,
              theme: state.theme,
              messages: state.messages,
              debugMode: state.debugMode
            })
          })
          if (postRes.ok) {
            useAppStore.setState({ serverSaveStatus: 'saved', lastSyncedAt: new Date().toISOString() })
          } else {
            useAppStore.setState({ serverSaveStatus: 'failed' })
          }
        }
      } else {
        useAppStore.setState({ serverSaveStatus: 'failed' })
      }
    } catch (e) {
      console.error('Failed to load server data during initialization', e)
      useAppStore.setState({ serverSaveStatus: 'failed' })
    } finally {
      // Fetch available books list after sync is complete
      await useAppStore.getState().fetchAvailableBooks()
    }
  }

  if (forceRemoteSync) {
    await performSync()
  } else {
    // Execute asynchronously to allow render loop to run immediately
    performSync()
  }
}
