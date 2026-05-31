import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getCookie, clearCookie, localStorage as ls } from '../persistence'

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
