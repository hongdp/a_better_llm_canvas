import type { StateCreator } from 'zustand'
import type { LLMProvider, ImageGenConfig, ProviderConfig, SystemPromptTemplate } from '../../types/llm'
import type { AppState } from '../types'
import { localStorage } from '../persistence'
import {
  getCookie,
  setCookie,
  saveSystemPromptsToCookie,
  loadSavedSystemPromptsData,
  saveConfigsToCookie,
  loadSavedConfigs,
  loadSavedProvider,
  loadSavedTheme,
  loadSavedLanguage,
  loadSavedDebugMode,
  loadSavedImageAnalysisPrompt,
  loadSavedImageGenConfig,
} from '../settingsPersistence'

export interface SettingsSlice {
  // Theme & Language state
  theme: 'dark' | 'light'
  setTheme: (theme: 'dark' | 'light') => void
  language: 'en' | 'zh'
  setLanguage: (lang: 'en' | 'zh') => void

  // LLM configurations
  activeProvider: LLMProvider
  providerConfigs: Record<LLMProvider, ProviderConfig>
  setProvider: (provider: LLMProvider) => void
  updateProviderConfig: (provider: LLMProvider, config: Partial<ProviderConfig>) => void
  availableGeminiModels: string[]
  setAvailableGeminiModels: (models: string[]) => void
  availableGrokModels: string[]
  setAvailableGrokModels: (models: string[]) => void
  debugMode: boolean
  setDebugMode: (enabled: boolean) => void
  // Agentic chapter lookup: lets the model request full chapter text
  // mid-turn via the <lookup> protocol (multi-chapter books only).
  agenticLookupEnabled: boolean
  setAgenticLookupEnabled: (enabled: boolean) => void

  // Image analysis prompt
  imageAnalysisPrompt: string
  setImageAnalysisPrompt: (prompt: string) => void

  // Image generation config
  imageGenConfig: ImageGenConfig
  updateImageGenConfig: (updates: Partial<ImageGenConfig>) => void

  // System prompts list
  customSystemPrompts: SystemPromptTemplate[]
  activeSystemPromptId: string
  setActiveSystemPromptId: (id: string) => void
  addSystemPrompt: (name?: string, content?: string) => string
  updateSystemPrompt: (id: string, updates: Partial<SystemPromptTemplate>) => void
  deleteSystemPrompt: (id: string) => void
}

export const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice> = (set) => {
  const initialPromptsData = loadSavedSystemPromptsData()
  if (!localStorage.getItem('web_canvas_system_prompts_backup') && !getCookie('__Secure-web_canvas_system_prompts')) {
    saveSystemPromptsToCookie(initialPromptsData.prompts, initialPromptsData.activePromptId)
  }
  const isEnvDebug = import.meta.env.VITE_DEBUG === 'true' || import.meta.env.MODE === 'debug'
  const initialDebugMode = isEnvDebug || loadSavedDebugMode() || (localStorage.getItem('web_canvas_debug_mode') === null && getCookie('__Secure-web_canvas_debug_mode') === '' && import.meta.env.DEV)

  return {
    // Theme & Language state
    theme: loadSavedTheme(),
    setTheme: (theme) => {
      localStorage.setItem('web_canvas_theme', theme)
      setCookie('__Secure-web_canvas_theme', theme)
      set({ theme })
    },
    language: loadSavedLanguage(),
    setLanguage: (language) => {
      localStorage.setItem('web_canvas_language', language)
      setCookie('__Secure-web_canvas_language', language)
      set({ language })
    },

    // LLM configurations
    activeProvider: loadSavedProvider(),
    providerConfigs: loadSavedConfigs(),
    availableGeminiModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash-8b'],
    availableGrokModels: ['grok-4.3', 'grok-build-0.1', 'grok-3', 'grok-2', 'grok-2-vision', 'grok-beta'],
    setProvider: (provider) => {
      localStorage.setItem('web_canvas_active_provider', provider)
      setCookie('__Secure-web_canvas_active_provider', provider)
      set({ activeProvider: provider })
    },
    setAvailableGeminiModels: (models) => {
      set({ availableGeminiModels: models })
    },
    setAvailableGrokModels: (models) => {
      set({ availableGrokModels: models })
    },
    updateProviderConfig: (provider, newConfig) => {
      set((state) => {
        const updatedConfigs = {
          ...state.providerConfigs,
          [provider]: {
            ...state.providerConfigs[provider],
            ...newConfig,
          },
        }
        saveConfigsToCookie(updatedConfigs)
        return { providerConfigs: updatedConfigs }
      })
    },
    agenticLookupEnabled: localStorage.getItem('web_canvas_agentic_lookup') !== 'false',
    setAgenticLookupEnabled: (enabled) => {
      localStorage.setItem('web_canvas_agentic_lookup', String(enabled))
      set({ agenticLookupEnabled: enabled })
    },
    debugMode: initialDebugMode,
    setDebugMode: (enabled) => {
      localStorage.setItem('web_canvas_debug_mode', String(enabled))
      setCookie('__Secure-web_canvas_debug_mode', String(enabled))
      set({ debugMode: enabled })
    },

    imageAnalysisPrompt: loadSavedImageAnalysisPrompt(),
    setImageAnalysisPrompt: (prompt) => {
      localStorage.setItem('web_canvas_image_analysis_prompt', prompt)
      set({ imageAnalysisPrompt: prompt })
    },

    // Image generation config
    imageGenConfig: loadSavedImageGenConfig(),
    updateImageGenConfig: (updates) => {
      set((state) => {
        const newConfig = { ...state.imageGenConfig, ...updates }
        localStorage.setItem('web_canvas_image_gen_config', JSON.stringify(newConfig))
        return { imageGenConfig: newConfig }
      })
    },

    // System prompts state
    customSystemPrompts: initialPromptsData.prompts,
    activeSystemPromptId: initialPromptsData.activePromptId,
    setActiveSystemPromptId: (id) => {
      set((state) => {
        saveSystemPromptsToCookie(state.customSystemPrompts, id)
        return { activeSystemPromptId: id }
      })
    },
    addSystemPrompt: (name = 'New Preset', content = '') => {
      const newPrompt: SystemPromptTemplate = {
        id: `prompt-${Date.now()}`,
        name,
        content
      }
      const promptId = newPrompt.id
      set((state) => {
        const updated = [...state.customSystemPrompts, newPrompt]
        saveSystemPromptsToCookie(updated, state.activeSystemPromptId)
        return { customSystemPrompts: updated }
      })
      return promptId
    },
    updateSystemPrompt: (id, updates) => {
      set((state) => {
        const updated = state.customSystemPrompts.map((p) => {
          if (p.id === id) {
            return { ...p, ...updates }
          }
          return p
        })
        saveSystemPromptsToCookie(updated, state.activeSystemPromptId)
        return { customSystemPrompts: updated }
      })
    },
    deleteSystemPrompt: (id) => {
      set((state) => {
        const updated = state.customSystemPrompts.filter((p) => p.id !== id)
        let activeId = state.activeSystemPromptId
        if (state.activeSystemPromptId === id) {
          activeId = updated[0]?.id || 'prompt-none'
        }
        saveSystemPromptsToCookie(updated, activeId)
        return {
          customSystemPrompts: updated,
          activeSystemPromptId: activeId
        }
      })
    },
  }
}
