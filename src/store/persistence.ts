/**
 * Persistence layer for the app store.
 * Provides safe wrappers around localStorage, IndexedDB, and cookie access.
 */
import type { CanvasDocument } from '../types/document'

// ── Safe localStorage wrapper ─────────────────────────────────────────────────
const rawLocalStorage = typeof window !== 'undefined' ? window.localStorage : null

export const localStorage = {
  setItem: (key: string, value: string) => {
    if (!rawLocalStorage) return
    try {
      rawLocalStorage.setItem(key, value)
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
        console.warn(`[Storage] localStorage quota exceeded for key "${key}" (${(value.length / 1024 / 1024).toFixed(1)}MB).`)
      } else {
        console.error(`[Storage] Failed to write to localStorage for key "${key}":`, e)
      }
    }
  },
  getItem: (key: string) => rawLocalStorage ? rawLocalStorage.getItem(key) : null,
  removeItem: (key: string) => rawLocalStorage ? rawLocalStorage.removeItem(key) : undefined,
  clear: () => rawLocalStorage ? rawLocalStorage.clear() : undefined,
  key: (index: number) => rawLocalStorage ? rawLocalStorage.key(index) : null,
  get length() { return rawLocalStorage ? rawLocalStorage.length : 0 }
}

// ── IndexedDB wrapper ─────────────────────────────────────────────────────────
const DB_NAME = 'web_canvas_indexeddb'
const STORE_NAME = 'keyval'

let dbInstance: IDBDatabase | null = null

const getDB = (): Promise<IDBDatabase> => {
  if (dbInstance) {
    return Promise.resolve(dbInstance)
  }
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('IndexedDB is only available in the browser.'))
      return
    }
    const request = window.indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const dbObj = request.result
      if (!dbObj.objectStoreNames.contains(STORE_NAME)) {
        dbObj.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => {
      dbInstance = request.result
      resolve(dbInstance)
    }
    request.onerror = () => reject(request.error)
  })
}

export const db = {
  get: async <T>(key: string): Promise<T | null> => {
    try {
      const database = await getDB()
      return new Promise<T | null>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly')
        const store = transaction.objectStore(STORE_NAME)
        const request = store.get(key)
        request.onsuccess = () => resolve((request.result as T) ?? null)
        request.onerror = () => reject(request.error)
      })
    } catch (e) {
      console.warn(`[IndexedDB] Get error for key "${key}":`, e)
      return null
    }
  },
  set: async <T>(key: string, value: T): Promise<void> => {
    try {
      const database = await getDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        const store = transaction.objectStore(STORE_NAME)
        const request = store.put(value, key)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    } catch (e) {
      console.error(`[IndexedDB] Set error for key "${key}":`, e)
    }
  },
  remove: async (key: string): Promise<void> => {
    try {
      const database = await getDB()
      return new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        const store = transaction.objectStore(STORE_NAME)
        const request = store.delete(key)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    } catch (e) {
      console.error(`[IndexedDB] Remove error for key "${key}":`, e)
    }
  }
}

export const safeIndexedDBSet = (key: string, value: unknown): void => {
  db.set(key, value).catch(err => {
    console.error(`[IndexedDB] safeIndexedDBSet failed for key "${key}":`, err)
  })
}

// ── Versioned documents envelope ──────────────────────────────────────────────
// Documents persist in IndexedDB inside a versioned envelope so the shape can
// evolve with sequential migrations. History:
//   v0 — legacy bare CanvasDocument[] written before envelopes existed
//   v1 — envelope introduced; docs gained optional summary fields
//   v2 — per-doc selectedReferenceIds replaced by pinnedReferenceIds (sticky
//        pins) + blockedReferenceIds (never auto-attach)
export const DOCUMENTS_ENVELOPE_VERSION = 2

export interface DocumentsEnvelope {
  version: number
  data: CanvasDocument[]
}

/** v1 → v2: the old manual selection becomes sticky pins. */
const migrateDocsV1toV2 = (docs: CanvasDocument[]): CanvasDocument[] =>
  docs.map(doc => {
    if (doc.pinnedReferenceIds !== undefined || doc.selectedReferenceIds === undefined) {
      return doc
    }
    const { selectedReferenceIds, ...rest } = doc
    return { ...rest, pinnedReferenceIds: selectedReferenceIds, blockedReferenceIds: [] }
  })

/**
 * Migrate a raw persisted documents payload (any historical shape) to the
 * current version. Returns null for unrecognized/corrupt payloads so callers
 * fall back to defaults instead of loading garbage.
 */
export const migrateDocumentsPayload = (raw: unknown): CanvasDocument[] | null => {
  if (raw == null) return null

  let version: number
  let docs: CanvasDocument[]
  if (Array.isArray(raw)) {
    // v0: legacy bare array (v0 → v1 added only optional fields; no rewrite)
    version = 1
    docs = raw as CanvasDocument[]
  } else if (typeof raw === 'object' && 'version' in raw && Array.isArray((raw as DocumentsEnvelope).data)) {
    const envelope = raw as DocumentsEnvelope
    if (envelope.version < 1 || envelope.version > DOCUMENTS_ENVELOPE_VERSION) {
      // A future version we don't understand — refuse rather than mis-read.
      console.warn(`[Storage] Unknown documents envelope version ${envelope.version}; ignoring.`)
      return null
    }
    version = envelope.version
    docs = envelope.data
  } else {
    console.warn('[Storage] Unrecognized documents payload shape; ignoring.')
    return null
  }

  // Sequential migrations to the current version.
  if (version < 2) docs = migrateDocsV1toV2(docs)
  return docs
}

// ── v3: per-document records ──────────────────────────────────────────────────
// Problem: v0–v2 stored the WHOLE documents array as one IndexedDB value, so
//   every debounced save structured-cloned the entire book (base64 images
//   included) on the main thread. Desktops absorbed it; on phones a single
//   edit in a large book froze the UI for seconds (worst in mobile Firefox).
// Fix: v3 stores one record per document (`web_canvas_doc:<id>`) plus a
//   small index, and the writer diffs against the last-written snapshot by
//   reference so a save touches ONLY the documents that actually changed.
const DOC_KEY_PREFIX = 'web_canvas_doc:'

interface DocumentsIndexV3 {
  version: 3
  ids: string[]
}

const isV3Index = (raw: unknown): raw is DocumentsIndexV3 =>
  typeof raw === 'object' && raw !== null &&
  (raw as DocumentsIndexV3).version === 3 &&
  Array.isArray((raw as DocumentsIndexV3).ids)

/** Last-written snapshot, by doc id. Reference equality is enough: the store
 * replaces a document object whenever it changes. */
let lastWrittenById: Map<string, CanvasDocument> | null = null

/** Pure diff of what a save must write/remove; exported for tests. */
export const diffDocumentsForWrite = (
  prev: ReadonlyMap<string, CanvasDocument> | null,
  documents: CanvasDocument[]
): { changed: CanvasDocument[]; removedIds: string[]; indexChanged: boolean } => {
  if (!prev) {
    return { changed: [...documents], removedIds: [], indexChanged: true }
  }
  const changed = documents.filter(d => prev.get(d.id) !== d)
  const ids = new Set(documents.map(d => d.id))
  const prevIds = [...prev.keys()]
  const removedIds = prevIds.filter(id => !ids.has(id))
  const indexChanged =
    removedIds.length > 0 ||
    documents.length !== prev.size ||
    documents.some((d, i) => prevIds[i] !== d.id)
  return { changed, removedIds, indexChanged }
}

const writeDocuments = (documents: CanvasDocument[]) => {
  const { changed, removedIds, indexChanged } = diffDocumentsForWrite(lastWrittenById, documents)
  for (const doc of changed) {
    safeIndexedDBSet(DOC_KEY_PREFIX + doc.id, doc)
  }
  for (const id of removedIds) {
    void db.remove(DOC_KEY_PREFIX + id)
  }
  if (indexChanged || lastWrittenById === null) {
    safeIndexedDBSet('web_canvas_documents', { version: 3, ids: documents.map(d => d.id) } satisfies DocumentsIndexV3)
  }
  lastWrittenById = new Map(documents.map(d => [d.id, d]))
}

/**
 * Load documents from IndexedDB, migrating legacy payloads (v0–v2 whole-array
 * shapes) to the per-document v3 layout. Migrated payloads are rewritten back
 * to storage; the legacy monolithic value is replaced by the v3 index.
 */
export const loadDocumentsFromIndexedDB = async (): Promise<CanvasDocument[] | null> => {
  const raw = await db.get<unknown>('web_canvas_documents')

  if (isV3Index(raw)) {
    const docs = await Promise.all(raw.ids.map(id => db.get<CanvasDocument>(DOC_KEY_PREFIX + id)))
    const documents = docs.filter((d): d is CanvasDocument => d !== null)
    lastWrittenById = new Map(documents.map(d => [d.id, d]))
    return documents.length > 0 ? documents : null
  }

  const documents = migrateDocumentsPayload(raw)
  if (documents) {
    // One-time upgrade: write per-doc records + index over the legacy value.
    lastWrittenById = null
    writeDocuments(documents)
  }
  return documents
}

// ── Debounced document save ───────────────────────────────────────────────────
let saveDocsTimeout: ReturnType<typeof setTimeout> | null = null

export const saveDocumentsToIndexedDB = (documents: CanvasDocument[], immediate = false) => {
  if (immediate) {
    if (saveDocsTimeout) {
      clearTimeout(saveDocsTimeout)
      saveDocsTimeout = null
    }
    writeDocuments(documents)
  } else {
    if (saveDocsTimeout) clearTimeout(saveDocsTimeout)
    saveDocsTimeout = setTimeout(() => {
      writeDocuments(documents)
      saveDocsTimeout = null
    }, 1000)
  }
}

/**
 * Flush any pending debounced document save immediately.
 * Called from the store's beforeunload handler.
 */
export const flushPendingDocumentSave = (documents: CanvasDocument[]) => {
  if (saveDocsTimeout) {
    clearTimeout(saveDocsTimeout)
    saveDocsTimeout = null
    writeDocuments(documents)
  }
}

// ── Cookie helpers ────────────────────────────────────────────────────────────
export const getCookie = (name: string): string | null => {
  if (typeof document === 'undefined') return null
  const nameEQ = name + '='
  const ca = document.cookie.split(';')
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i]
    while (c.charAt(0) === ' ') c = c.substring(1, c.length)
    if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length))
  }
  return null
}

export const clearCookie = (name: string) => {
  if (typeof document !== 'undefined') {
    document.cookie = `${name}=; path=/; max-age=0`
  }
}

// ── Whole-book mode ───────────────────────────────────────────────────────────
/** Whole-book context mode: off, one-shot, or sticky across turns. */
export type WholeBookMode = 'off' | 'once' | 'sticky'

const WHOLE_BOOK_MODE_KEY = 'web_canvas_whole_book_mode'

/**
 * Restore the whole-book mode chosen in a previous session.
 *
 * Only `sticky` survives a reload: it is an explicit standing choice ("keep
 * sending the whole book"), whereas `once` is consumed by the very next send
 * and would be a surprise if it came back. Anything unrecognized reads as off.
 */
export const loadWholeBookMode = (): WholeBookMode =>
  localStorage.getItem(WHOLE_BOOK_MODE_KEY) === 'sticky' ? 'sticky' : 'off'

/** Persist `sticky`; any other mode clears the stored preference. */
export const saveWholeBookMode = (mode: WholeBookMode) => {
  if (mode === 'sticky') {
    localStorage.setItem(WHOLE_BOOK_MODE_KEY, 'sticky')
  } else {
    localStorage.removeItem(WHOLE_BOOK_MODE_KEY)
  }
}
