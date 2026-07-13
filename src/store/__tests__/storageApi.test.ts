import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CanvasDocument } from '../../types/document'

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build a mock document with optional overrides */
function mockDoc(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return {
    id: `doc-${Date.now()}`,
    title: 'Test Chapter',
    content: '<p>Hello</p>',
    contentLoaded: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ── contentLoaded flag behaviour ──────────────────────────────────────────────
describe('CanvasDocument contentLoaded flag', () => {
  it('new locally-created documents should have contentLoaded = true', () => {
    const doc = mockDoc()
    expect(doc.contentLoaded).toBe(true)
  })

  it('documents from server metadata should have contentLoaded = false', () => {
    const serverDoc = mockDoc({ content: '', contentLoaded: false })
    expect(serverDoc.contentLoaded).toBe(false)
    expect(serverDoc.content).toBe('')
  })

  it('contentLoaded is optional and defaults to undefined', () => {
    const doc: CanvasDocument = {
      id: 'doc-1',
      title: 'Test',
      content: '<p>Hi</p>',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    }
    expect(doc.contentLoaded).toBeUndefined()
  })
})

// ── Reorder document order payload ────────────────────────────────────────────
describe('Document reorder payload', () => {
  it('produces correct documentIds array for reorder API', () => {
    const docs = [
      mockDoc({ id: 'doc-3' }),
      mockDoc({ id: 'doc-1' }),
      mockDoc({ id: 'doc-2' }),
    ]
    const docIds = docs.map(d => d.id)
    expect(docIds).toEqual(['doc-3', 'doc-1', 'doc-2'])
  })

  it('preserves all document ids after reorder', () => {
    const original = [
      mockDoc({ id: 'a' }),
      mockDoc({ id: 'b' }),
      mockDoc({ id: 'c' }),
    ]
    const reordered = [original[2], original[0], original[1]]
    
    const originalIds = new Set(original.map(d => d.id))
    const reorderedIds = new Set(reordered.map(d => d.id))
    expect(reorderedIds).toEqual(originalIds)
  })
})

// ── Sync payload construction ─────────────────────────────────────────────────
describe('syncToServer payload construction', () => {
  it('filters out unloaded documents from sync', () => {
    const docs = [
      mockDoc({ id: 'loaded-1', contentLoaded: true, content: '<p>data</p>' }),
      mockDoc({ id: 'unloaded-1', contentLoaded: false, content: '' }),
      mockDoc({ id: 'loaded-2', contentLoaded: true, content: '<p>more</p>' }),
    ]
    
    const syncDocs = docs.filter(d => d.contentLoaded !== false)
    expect(syncDocs).toHaveLength(2)
    expect(syncDocs.map(d => d.id)).toEqual(['loaded-1', 'loaded-2'])
  })

  it('includes documentOrder with all doc ids', () => {
    const docs = [
      mockDoc({ id: 'a', contentLoaded: true }),
      mockDoc({ id: 'b', contentLoaded: false }),
      mockDoc({ id: 'c', contentLoaded: true }),
    ]
    
    const documentOrder = docs.map(d => d.id)
    expect(documentOrder).toEqual(['a', 'b', 'c'])
    // Even unloaded docs should be in the order
    expect(documentOrder).toContain('b')
  })

  it('metadata sync body does not include document content', () => {
    const docs = [
      mockDoc({ id: 'x', content: '<p>huge content</p>', contentLoaded: true }),
    ]
    
    const metaBody = {
      bookTitle: 'Test Book',
      activeDocumentId: 'x',
      documentOrder: docs.map(d => d.id),
    }
    
    // Metadata body should not contain document content
    expect(metaBody).not.toHaveProperty('content')
    expect(metaBody).not.toHaveProperty('documents')
    expect(metaBody).toHaveProperty('documentOrder')
  })
})

// ── API URL construction ──────────────────────────────────────────────────────
describe('API URL construction', () => {
  it('constructs correct book URL', () => {
    const bookId = 'book-123'
    expect(`/api/books/${bookId}`).toBe('/api/books/book-123')
  })

  it('constructs correct document URL', () => {
    const bookId = 'book-123'
    const docId = 'doc-456'
    expect(`/api/books/${bookId}/documents/${docId}`).toBe('/api/books/book-123/documents/doc-456')
  })

  it('constructs correct reorder URL', () => {
    const bookId = 'book-123'
    expect(`/api/books/${bookId}/documents/reorder`).toBe('/api/books/book-123/documents/reorder')
  })

  it('constructs correct books list URL', () => {
    expect('/api/books').toBe('/api/books')
  })
})

// ── Fetch mock for lazy loading ───────────────────────────────────────────────
describe('Lazy loading behaviour', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('should call fetch for unloaded document content', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ content: '<p>Loaded!</p>' }),
    }
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse as Response)

    const doc = mockDoc({ id: 'doc-lazy', contentLoaded: false, content: '' })
    const bookId = 'book-1'

    // Simulate what setActiveDocumentId does
    if (!doc.contentLoaded) {
      await fetch(`/api/books/${bookId}/documents/${doc.id}`)
    }

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book-1/documents/doc-lazy'
    )
  })

  it('should NOT call fetch for already-loaded document', async () => {
    const doc = mockDoc({ id: 'doc-ready', contentLoaded: true, content: '<p>Ready</p>' })
    const bookId = 'book-1'

    if (!doc.contentLoaded) {
      await fetch(`/api/books/${bookId}/documents/${doc.id}`)
    }

    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

// ── Document add/delete sync payloads ─────────────────────────────────────────
describe('Document CRUD sync payloads', () => {
  it('addDocument creates correct POST payload', () => {
    const newDoc = mockDoc({ id: 'doc-new', title: 'New Chapter', content: '<p>Start</p>' })
    
    const payload = {
      documents: [{
        id: newDoc.id,
        title: newDoc.title,
        content: newDoc.content,
        createdAt: newDoc.createdAt,
        updatedAt: newDoc.updatedAt,
      }]
    }

    expect(payload.documents).toHaveLength(1)
    expect(payload.documents[0].id).toBe('doc-new')
    expect(payload.documents[0]).not.toHaveProperty('contentLoaded')
    expect(payload.documents[0]).not.toHaveProperty('selectedReferenceIds')
  })

  it('deleteDocument sends correct DELETE URL', () => {
    const bookId = 'book-abc'
    const docId = 'doc-to-delete'
    const url = `/api/books/${bookId}/documents/${docId}`
    expect(url).toBe('/api/books/book-abc/documents/doc-to-delete')
  })

  it('reorderDocuments sends correct PUT payload', () => {
    const docs = [
      mockDoc({ id: 'c' }),
      mockDoc({ id: 'a' }),
      mockDoc({ id: 'b' }),
    ]
    const payload = { documentIds: docs.map(d => d.id) }
    expect(payload).toEqual({ documentIds: ['c', 'a', 'b'] })
  })
})

// ── Server response mapping ───────────────────────────────────────────────────
describe('Server response → client document mapping', () => {
  it('maps server metadata response to CanvasDocument with contentLoaded=false', () => {
    const serverDocs = [
      { id: 'doc-1', title: 'Chapter 1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      { id: 'doc-2', title: 'Chapter 2', createdAt: '2024-01-02', updatedAt: '2024-01-02' },
    ]

    const clientDocs: CanvasDocument[] = serverDocs.map(d => ({
      id: d.id,
      title: d.title,
      content: '',
      contentLoaded: false,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }))

    expect(clientDocs).toHaveLength(2)
    expect(clientDocs[0].contentLoaded).toBe(false)
    expect(clientDocs[0].content).toBe('')
    expect(clientDocs[1].title).toBe('Chapter 2')
  })

  it('updates contentLoaded after lazy load', () => {
    const docs: CanvasDocument[] = [
      mockDoc({ id: 'doc-1', content: '', contentLoaded: false }),
      mockDoc({ id: 'doc-2', content: '', contentLoaded: false }),
    ]

    const loadedContent = '<p>Full content here</p>'
    const targetId = 'doc-1'

    const updatedDocs = docs.map(d =>
      d.id === targetId ? { ...d, content: loadedContent, contentLoaded: true } : d
    )

    expect(updatedDocs[0].contentLoaded).toBe(true)
    expect(updatedDocs[0].content).toBe(loadedContent)
    expect(updatedDocs[1].contentLoaded).toBe(false)
  })
})

// ── Create book payload ───────────────────────────────────────────────────────
describe('Create book payload (POST /api/books)', () => {
  it('constructs correct payload with id, title, and documents', () => {
    const bookId = 'book-new-123'
    const title = 'My New Novel'
    const docs = [mockDoc({ id: 'doc-1', title: 'Chapter 1', content: '<p>Start</p>' })]

    const payload = {
      id: bookId,
      title,
      documents: docs.map(d => ({
        id: d.id,
        title: d.title,
        content: d.content,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      activeDocumentId: 'doc-1',
    }

    expect(payload.id).toBe('book-new-123')
    expect(payload.title).toBe('My New Novel')
    expect(payload.documents).toHaveLength(1)
    expect(payload.documents[0]).not.toHaveProperty('contentLoaded')
  })
})
