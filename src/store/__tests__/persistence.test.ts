import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getCookie, clearCookie, localStorage as ls, migrateDocumentsPayload, DOCUMENTS_ENVELOPE_VERSION } from '../persistence'
import type { CanvasDocument } from '../../types/document'

// ── getCookie ─────────────────────────────────────────────────────────────────
describe('getCookie', () => {
  beforeEach(() => {
    document.cookie.split(';').forEach(cookie => {
      const name = cookie.split('=')[0].trim()
      if (name) document.cookie = `${name}=; max-age=0; path=/`
    })
  })

  it('returns null when the cookie does not exist', () => {
    expect(getCookie('nonexistent_cookie_xyz')).toBeNull()
  })

  it('returns the value when the cookie is set', () => {
    document.cookie = 'test_cookie=hello123; path=/'
    expect(getCookie('test_cookie')).toBe('hello123')
  })

  it('returns the correct value among multiple cookies', () => {
    document.cookie = 'cookie_a=valueA; path=/'
    document.cookie = 'cookie_b=valueB; path=/'
    expect(getCookie('cookie_a')).toBe('valueA')
    expect(getCookie('cookie_b')).toBe('valueB')
  })

  it('handles URL-encoded cookie values', () => {
    const encoded = encodeURIComponent('hello world / special&chars')
    document.cookie = `encoded_cookie=${encoded}; path=/`
    expect(getCookie('encoded_cookie')).toBe('hello world / special&chars')
  })
})

// ── clearCookie ───────────────────────────────────────────────────────────────
describe('clearCookie', () => {
  it('removes a cookie by setting max-age=0', () => {
    document.cookie = 'to_clear=value; path=/'
    clearCookie('to_clear')
    expect(document.cookie).not.toContain('to_clear=value')
  })

  it('does not throw when clearing a non-existent cookie', () => {
    expect(() => clearCookie('does_not_exist')).not.toThrow()
  })
})

// ── safeLocalStorage wrapper ──────────────────────────────────────────────────
// The ls wrapper captures window.localStorage at module import time.
// test-setup.ts installs a full in-memory polyfill so all Storage methods work.
describe('localStorage wrapper', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('sets and gets items', () => {
    ls.setItem('hello', 'world')
    expect(ls.getItem('hello')).toBe('world')
  })

  it('removeItem deletes the key', () => {
    ls.setItem('k', 'v')
    ls.removeItem('k')
    expect(ls.getItem('k')).toBeNull()
  })

  it('returns null for a missing key', () => {
    expect(ls.getItem('missing_key_xyz')).toBeNull()
  })

  it('length reflects number of stored items', () => {
    ls.setItem('a', '1')
    ls.setItem('b', '2')
    expect(ls.length).toBeGreaterThanOrEqual(2)
  })

  it('does not throw on QuotaExceededError — logs a warning instead', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Temporarily patch setItem on the polyfill to throw QuotaExceededError
    const originalSetItem = window.localStorage.setItem
    window.localStorage.setItem = (_key: string, _value: string) => {
      const err = new DOMException('QuotaExceededError')
      Object.defineProperty(err, 'name', { value: 'QuotaExceededError' })
      Object.defineProperty(err, 'code', { value: 22 })
      throw err
    }

    expect(() => ls.setItem('key', 'value')).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()

    window.localStorage.setItem = originalSetItem
    warnSpy.mockRestore()
  })
})

// ── migrateDocumentsPayload (versioned documents envelope) ────────────────────
describe('migrateDocumentsPayload', () => {
  const legacyDoc: CanvasDocument = {
    id: 'doc-1',
    title: 'Chapter 1',
    content: '<p>Hello</p>',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  }

  it('migrates a legacy v0 bare array, preserving all fields', () => {
    const result = migrateDocumentsPayload([legacyDoc])
    expect(result).toEqual([legacyDoc])
    // New optional summary fields default to absent — that is a valid v1 doc.
    expect(result![0].summary).toBeUndefined()
    expect(result![0].summaryContentHash).toBeUndefined()
  })

  it('reads a current-version envelope', () => {
    const doc: CanvasDocument = { ...legacyDoc, summary: 'A summary', summaryContentHash: 'abc123' }
    const result = migrateDocumentsPayload({ version: DOCUMENTS_ENVELOPE_VERSION, data: [doc] })
    expect(result).toEqual([doc])
    expect(result![0].summary).toBe('A summary')
  })

  it('returns null for null/undefined (first run, nothing stored)', () => {
    expect(migrateDocumentsPayload(null)).toBeNull()
    expect(migrateDocumentsPayload(undefined)).toBeNull()
  })

  it('refuses an unknown future envelope version', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(migrateDocumentsPayload({ version: DOCUMENTS_ENVELOPE_VERSION + 1, data: [legacyDoc] })).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('refuses corrupt payload shapes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(migrateDocumentsPayload('garbage')).toBeNull()
    expect(migrateDocumentsPayload({ version: 1 })).toBeNull()
    expect(migrateDocumentsPayload(42)).toBeNull()
    warnSpy.mockRestore()
  })

  it('accepts an empty legacy array (user deleted everything)', () => {
    expect(migrateDocumentsPayload([])).toEqual([])
  })

  it('migrates v0 selectedReferenceIds to pinnedReferenceIds', () => {
    const v0Doc = { ...legacyDoc, selectedReferenceIds: ['doc-2', 'doc-3'] }
    const result = migrateDocumentsPayload([v0Doc])
    expect(result![0].pinnedReferenceIds).toEqual(['doc-2', 'doc-3'])
    expect(result![0].blockedReferenceIds).toEqual([])
    expect(result![0].selectedReferenceIds).toBeUndefined()
  })

  it('migrates a v1 envelope to v2, converting selection to pins', () => {
    const v1Doc = { ...legacyDoc, summary: 'S', summaryContentHash: 'h', selectedReferenceIds: ['doc-9'] }
    const result = migrateDocumentsPayload({ version: 1, data: [v1Doc] })
    expect(result![0].pinnedReferenceIds).toEqual(['doc-9'])
    expect(result![0].selectedReferenceIds).toBeUndefined()
    // v1 fields survive the v1→v2 step
    expect(result![0].summary).toBe('S')
  })

  it('leaves docs without legacy selection untouched in v1→v2', () => {
    const result = migrateDocumentsPayload({ version: 1, data: [legacyDoc] })
    expect(result![0].pinnedReferenceIds).toBeUndefined()
    expect(result![0].blockedReferenceIds).toBeUndefined()
  })

  it('does not re-migrate a current v2 envelope', () => {
    const v2Doc: CanvasDocument = { ...legacyDoc, pinnedReferenceIds: ['a'], blockedReferenceIds: ['b'] }
    const result = migrateDocumentsPayload({ version: DOCUMENTS_ENVELOPE_VERSION, data: [v2Doc] })
    expect(result).toEqual([v2Doc])
  })
})
