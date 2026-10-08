/**
 * Live chapter changes from the server (docs/features/backend_authority.md
 * §2.2): one EventSource per open book.
 *
 * Another tab's or device's save arrives as it happens, instead of on the
 * next window focus — which reloaded the whole book. This tab ignores the
 * echo of its own writes (they carry its client id).
 *
 * A chapter with an unsynced edit here is never overwritten by an event:
 * its next save names its base revision, and the server turns the clash
 * into a conflict, kept in version history (documentSync), not a silent loss.
 */
import type { CanvasDocument } from '../types/document'
import type { ServerDocumentMeta } from './types'
import { useAppStore } from './useAppStore'
import { saveDocumentsToIndexedDB } from './persistence'
import { CLIENT_ID, adoptServerChapter, mergeServerChapters } from './documentSync'
import { normalizeBrParagraphs } from '../utils/convert'

export interface BookEvent {
  id: number
  type: 'document' | 'documents'
  kind: 'updated' | 'deleted' | 'created' | 'replaced' | 'reordered'
  documentId?: string
  documentIds?: string[]
  revision?: number
  clientId?: string | null
}

export interface BookEventDeps {
  bookId: string
  fetchFn?: typeof fetch
}

const docOf = (id: string) => useAppStore.getState().documents.find(d => d.id === id)

/** Fetch a chapter and adopt it, unless it holds an unsynced edit by then. */
async function refetchChapter(id: string, deps: BookEventDeps): Promise<void> {
  const res = await (deps.fetchFn ?? fetch)(`/api/books/${deps.bookId}/documents/${id}`)
  if (!res.ok) return
  const data = await res.json()
  // The user may have typed while the request was in flight.
  const now = docOf(id)
  if (!now || now.unsynced || typeof data?.content !== 'string') return
  adoptServerChapter(id, {
    title: data.title,
    content: normalizeBrParagraphs(data.content),
    ...(typeof data.revision === 'number' ? { revision: data.revision } : {})
  })
}

/**
 * Bring the book in line with the server: its chapter list and order, and
 * any loaded chapter whose revision moved. Used for structural events and
 * after a reconnect, when events may have been missed.
 */
export async function resyncBook(deps: BookEventDeps): Promise<void> {
  const res = await (deps.fetchFn ?? fetch)(`/api/books/${deps.bookId}`)
  if (!res.ok) return
  const server = await res.json()
  if (!Array.isArray(server?.documents) || useAppStore.getState().activeBookId !== deps.bookId) return
  const local = useAppStore.getState().documents
  const localById = new Map(local.map(d => [d.id, d]))
  const stale: string[] = []
  const listed: CanvasDocument[] = server.documents.map((m: ServerDocumentMeta) => {
    const mine = localById.get(m.id)
    if (!mine) {
      return {
        id: m.id, title: m.title, content: '', contentLoaded: false, createdAt: m.createdAt, updatedAt: m.updatedAt,
        summary: m.summary ?? undefined, summaryContentHash: m.summaryContentHash ?? undefined,
        ...(typeof m.revision === 'number' ? { revision: m.revision } : {})
      }
    }
    if (typeof m.revision === 'number' && !mine.unsynced && mine.revision !== m.revision) {
      if (mine.contentLoaded === false) return { ...mine, title: m.title, revision: m.revision }
      stale.push(m.id)
    }
    return mine
  })
  const documents = mergeServerChapters(listed, local)
  const activeGone = !documents.some(d => d.id === useAppStore.getState().activeDocumentId)
  useAppStore.setState({
    documents,
    ...(activeGone && documents[0] ? { activeDocumentId: documents[0].id } : {})
  })
  saveDocumentsToIndexedDB(documents, true)
  await Promise.all(stale.map(id => refetchChapter(id, deps)))
}

/** Apply one event. Exported for tests. */
export async function applyBookEvent(event: BookEvent, deps: BookEventDeps): Promise<void> {
  if (event.clientId === CLIENT_ID) return
  if (event.type === 'document' && event.kind === 'updated' && event.documentId) {
    const doc = docOf(event.documentId)
    if (!doc) return resyncBook(deps)
    if (doc.unsynced) return
    if (doc.revision !== undefined && event.revision !== undefined && doc.revision >= event.revision) return
    if (doc.contentLoaded === false) {
      // Not loaded here: it loads fresh when opened. Keep the revision current.
      useAppStore.setState(s => ({ documents: s.documents.map(d => d.id === doc.id ? { ...d, revision: event.revision } : d) }))
      return
    }
    return refetchChapter(doc.id, deps)
  }
  // Deleted, created, replaced, reordered: the list itself changed.
  return resyncBook(deps)
}

/**
 * Subscribe to the book's events; returns the unsubscribe. A no-op where
 * EventSource does not exist (tests, very old browsers): the focus-time
 * check still catches up.
 */
export function connectBookEvents(bookId: string): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const deps: BookEventDeps = { bookId }
  const source = new EventSource(`/api/books/${bookId}/events`)
  let dropped = false
  source.onmessage = (message) => {
    try {
      void applyBookEvent(JSON.parse(message.data) as BookEvent, deps)
    } catch (e) {
      console.error('[bookEvents] bad event', e)
    }
  }
  source.onerror = () => { dropped = true }
  // EventSource reconnects on its own; what was published meanwhile is lost,
  // so catch up once it is back.
  source.onopen = () => {
    if (!dropped) return
    dropped = false
    void resyncBook(deps)
  }
  return () => source.close()
}
