import type { StateCreator } from 'zustand'
import type { Editor } from '@tiptap/react'
import type { RoleplayConfig } from '../../types/chat'
import type { AppState } from '../types'
import { localStorage } from '../persistence'
import { setCookie, loadSavedSidebarOpen } from '../settingsPersistence'

export interface UiSlice {
  isSidebarOpen: boolean
  toggleSidebar: () => void

  // Roleplay game mode state
  roleplayMode: boolean
  roleplayConfig: RoleplayConfig | null
  setRoleplayMode: (active: boolean) => void
  setRoleplayConfig: (config: RoleplayConfig | null) => void

  // Selection & editor integration for inline diff review
  selectedText: string
  setSelectedText: (text: string) => void
  activeEditor: Editor | null
  setActiveEditor: (editor: Editor | null) => void
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set) => ({
  isSidebarOpen: loadSavedSidebarOpen(),

  toggleSidebar: () => {
    set((state) => {
      const isOpen = !state.isSidebarOpen
      localStorage.setItem('web_canvas_sidebar_open', String(isOpen))
      setCookie('__Secure-web_canvas_sidebar_open', String(isOpen))
      return { isSidebarOpen: isOpen }
    })
  },

  // Roleplay game mode state
  roleplayMode: false,
  roleplayConfig: null,
  setRoleplayMode: (active) => set({ roleplayMode: active }),
  setRoleplayConfig: (config) => set({ roleplayConfig: config }),

  // Selection & editor state implementation
  selectedText: '',
  setSelectedText: (text) => set({ selectedText: text }),
  activeEditor: null,
  setActiveEditor: (editor) => set({ activeEditor: editor }),
})
