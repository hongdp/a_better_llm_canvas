import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { localStorage, db } from '../persistence'
import { setCookie } from '../settingsPersistence'
import { DEFAULT_CONFIGS, DEFAULT_SYSTEM_PROMPTS, MOCK_DOCUMENTS } from '../defaults'
import { clearPendingSave } from '../syncRuntime'
// Benign import cycle: serverSync only references useAppStore inside function
// bodies, and this slice only calls initializeStoreFromServer at login time.
import { initializeStoreFromServer } from '../serverSync'
// Benign import cycle: this module only references useAppStore inside action
// bodies, which run long after both modules have finished evaluating.
import { useAppStore } from '../useAppStore'

export interface AuthSlice {
  // Auth state
  user: { username: string } | null
  csrfToken: string | null
  setUser: (user: { username: string } | null) => void
  setCsrfToken: (token: string | null) => void
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  checkSession: () => Promise<void>
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (set) => ({
  // Auth implementation
  user: null,
  csrfToken: null,
  setUser: (user) => set({ user }),
  setCsrfToken: (token) => set({ csrfToken: token }),
  login: async (username, password) => {
    const state = useAppStore.getState()
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.csrfToken || ''
      },
      body: JSON.stringify({ username, password })
    })
    if (!res.ok) {
      let errMsg = 'Login failed.'
      try {
        const contentType = res.headers.get('content-type')
        if (contentType && contentType.includes('application/json')) {
          const errData = await res.json()
          errMsg = errData.error || errData.detail || errMsg
        } else {
          const text = await res.text()
          if (text && text.trim().length > 0 && text.length < 200) {
            errMsg = text.trim()
          } else {
            errMsg = `Server error: HTTP ${res.status}`
          }
        }
      } catch {
        errMsg = `Server error: HTTP ${res.status}`
      }
      throw new Error(errMsg)
    }
    const data = await res.json()
    set({ user: { username: data.username }, csrfToken: data.csrfToken || state.csrfToken })

    // Perform sync verification for this logged in user
    await initializeStoreFromServer(true)
    // Fetch available books
    await useAppStore.getState().fetchAvailableBooks()
  },
  register: async (username, password) => {
    const state = useAppStore.getState()
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.csrfToken || ''
      },
      body: JSON.stringify({ username, password })
    })
    if (!res.ok) {
      let errMsg = 'Registration failed.'
      try {
        const contentType = res.headers.get('content-type')
        if (contentType && contentType.includes('application/json')) {
          const errData = await res.json()
          errMsg = errData.error || errData.detail || errMsg
        } else {
          const text = await res.text()
          if (text && text.trim().length > 0 && text.length < 200) {
            errMsg = text.trim()
          } else {
            errMsg = `Server error: HTTP ${res.status}`
          }
        }
      } catch {
        errMsg = `Server error: HTTP ${res.status}`
      }
      throw new Error(errMsg)
    }
  },
  logout: async () => {
    const state = useAppStore.getState()

    // Flush any pending saves to prevent data loss
    clearPendingSave()
    if (state.serverSaveStatus === 'saving') {
      try {
        await state.syncToServer()
      } catch (e) {
        console.error('Failed to flush save before logout', e)
      }
    }

    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'X-CSRF-Token': state.csrfToken || ''
        }
      })
    } catch (e) {
      console.error('Logout request failed', e)
    }
    // Clear IndexedDB cache to be completely secure and avoid PII leaks
    db.remove('web_canvas_documents')
    db.remove('web_canvas_versions')
    localStorage.removeItem('web_canvas_book_title')
    localStorage.removeItem('web_canvas_active_document_id')
    localStorage.removeItem('web_canvas_active_book_id')
    localStorage.removeItem('web_canvas_system_prompts_backup')
    localStorage.removeItem('web_canvas_providers_backup')
    localStorage.removeItem('web_canvas_theme')
    localStorage.removeItem('web_canvas_sidebar_open')
    localStorage.removeItem('web_canvas_debug_mode')
    localStorage.removeItem('web_canvas_active_provider')

    // Clear cookies that might have been set
    setCookie('__Secure-web_canvas_theme', '', -1)
    setCookie('__Secure-web_canvas_sidebar_open', '', -1)
    setCookie('__Secure-web_canvas_debug_mode', '', -1)
    setCookie('__Secure-web_canvas_active_provider', '', -1)
    setCookie('__Secure-web_canvas_system_prompts', '', -1)
    setCookie('__Secure-web_canvas_providers', '', -1)

    set({
      user: null,
      activeBookId: 'default',
      availableBooks: [],
      lastSyncedAt: null,
      customSystemPrompts: DEFAULT_SYSTEM_PROMPTS,
      activeSystemPromptId: 'prompt-none',
      providerConfigs: DEFAULT_CONFIGS,
      activeProvider: 'gemini',
      theme: 'dark',
      isSidebarOpen: true,
      debugMode: false,
      documents: MOCK_DOCUMENTS,
      activeDocumentId: 'doc-1',
      versions: [],
      messages: [
        {
          id: 'welcome',
          role: 'assistant',
          content: "Hello! I'm your Web Canvas assistant. You can write your document directly in the right panel, or tell me what you want to write and I can draft it for you. How can I help you today?",
          timestamp: new Date().toISOString(),
        },
      ]
    })
  },
  checkSession: async () => {
    try {
      const res = await fetch('/api/auth/session')
      if (res.ok) {
        const data = await res.json()
        set({ csrfToken: data.csrfToken })
        if (data.loggedIn) {
          set({ user: { username: data.username } })
        } else {
          set({ user: null })
        }
      }
    } catch (e) {
      console.error('Failed to check session', e)
    }
  },
})
