import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

const FALLBACK_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b'
]

const FALLBACK_GROK_MODELS = [
  'grok-4.3',
  'grok-build-0.1',
  'grok-3',
  'grok-2',
  'grok-2-vision',
  'grok-beta'
]

export function useModelFetcher(
  // When true the hook fetches the live model lists. Passed `isSettingsOpen`
  // from the Settings modal (so it refreshes + surfaces errors there), and
  // `true` from the app root so the top-bar model dropdown is populated even
  // before Settings is ever opened.
  enabled: boolean,
  setErrorMsg: (msg: string | null) => void,
  setIsLoadingModels: (loading: boolean) => void
) {
  const {
    providerConfigs,
    setAvailableGeminiModels,
    setAvailableGrokModels,
    updateProviderConfig
  } = useAppStore()

  const geminiConfig = providerConfigs.gemini
  const geminiApiKey = geminiConfig.apiKey
  const geminiBaseUrl = geminiConfig.baseUrl

  const grokConfig = providerConfigs.grok
  const grokApiKey = grokConfig.apiKey
  const grokBaseUrl = grokConfig.baseUrl

  // Fetch official Gemini models dynamically when API Key or Base URL changes
  useEffect(() => {
    if (!enabled) return

    const fetchOfficialModels = async () => {
      if (!geminiApiKey || geminiApiKey === 'ollama-no-key') {
        setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
        return
      }

      setIsLoadingModels(true)
      try {
        let url = `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`
        if (geminiBaseUrl && geminiBaseUrl !== 'https://generativelanguage.googleapis.com/v1beta') {
          url = `${geminiBaseUrl.replace(/\/$/, '')}/models?key=${geminiApiKey}`
        }

        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          if (data.models && Array.isArray(data.models)) {
            const filtered = data.models
              .filter((m: { name: string; supportedGenerationMethods?: string[] }) => 
                (m.supportedGenerationMethods?.includes('generateContent') || 
                 m.supportedGenerationMethods?.includes('streamGenerateContent')) &&
                !m.name.includes('embedding') &&
                !m.name.includes('aqa')
              )
              .map((m: { name: string }) => {
                return m.name.startsWith('models/') ? m.name.slice(7) : m.name
              })

            if (filtered.length > 0) {
              setAvailableGeminiModels(filtered)
              if (!filtered.includes(geminiConfig.model)) {
                updateProviderConfig('gemini', { model: filtered[0] })
              }
              setErrorMsg(null)
            } else {
              setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
              setErrorMsg('No compatible generation models returned from Gemini API.')
            }
          } else {
            setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
            setErrorMsg('Invalid model list response format from Gemini API.')
          }
        } else {
          setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
          setErrorMsg(`Failed to load official Gemini models: ${res.status} ${res.statusText}. Using fallback models.`)
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        console.error('Failed to fetch official Gemini models, using fallbacks', err)
        setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
        setErrorMsg(`Failed to connect to Gemini API: ${err.message}. Using fallback models.`)
      } finally {
        setIsLoadingModels(false)
      }
    }

    fetchOfficialModels()
  }, [enabled, geminiApiKey, geminiBaseUrl, setAvailableGeminiModels, updateProviderConfig, geminiConfig.model, setErrorMsg, setIsLoadingModels])

  // Fetch official Grok models dynamically when API Key or Base URL changes
  useEffect(() => {
    if (!enabled) return

    const fetchGrokModels = async () => {
      if (!grokApiKey) {
        setAvailableGrokModels(FALLBACK_GROK_MODELS)
        return
      }
      try {
        const url = `${grokBaseUrl.replace(/\/$/, '')}/models`
        const res = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${grokApiKey}`
          }
        })
        if (res.ok) {
          const data = await res.json()
          if (data.data && Array.isArray(data.data)) {
            const list = data.data
              .map((m: { id: string }) => m.id)
              .sort((a: string, b: string) => {
                if (a.startsWith('grok-3') && !b.startsWith('grok-3')) return -1
                if (!a.startsWith('grok-3') && b.startsWith('grok-3')) return 1
                return a.localeCompare(b)
              })
            if (list.length > 0) {
              setAvailableGrokModels(list)
              if (!list.includes(grokConfig.model)) {
                updateProviderConfig('grok', { model: list[0] })
              }
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch official Grok models', err)
      }
    }
    fetchGrokModels()
  }, [enabled, grokApiKey, grokBaseUrl, setAvailableGrokModels, updateProviderConfig, grokConfig.model])
}
