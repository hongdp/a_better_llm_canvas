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


/**
 * Shapes a model listing into plain names.
 *
 * Three shapes reach this: OpenAI's `{data:[{id}]}`, Ollama's
 * `{models:[{name}]}`, and our own backend's already-normalized
 * `{models:["name"]}`. The last one is why the entry check is per-item rather
 * than per-shape — reading `.name` off a string yields undefined and silently
 * empties the list, which is exactly how this first shipped broken.
 */
function normalizeModelList(data: unknown): string[] {
  const payload = (data ?? {}) as {
    data?: Array<{ id?: string } | string>
    models?: Array<{ name?: string; model?: string } | string>
  }
  const nameOf = (entry: { id?: string; name?: string; model?: string } | string): string | undefined =>
    typeof entry === 'string' ? entry : entry?.id || entry?.name || entry?.model

  for (const list of [payload.data, payload.models]) {
    if (!Array.isArray(list)) continue
    const names = list.map(nameOf).filter((v): v is string => !!v)
    if (names.length > 0) return names
  }
  return []
}

async function listLocalModelsDirect(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`)
    if (!res.ok) return []
    return normalizeModelList(await res.json())
  } catch {
    return []
  }
}

async function listLocalModelsViaBackend(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': useAppStore.getState().csrfToken || ''
      },
      body: JSON.stringify({ baseUrl })
    })
    if (!res.ok) return []
    return normalizeModelList(await res.json())
  } catch {
    return []
  }
}

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
    setAvailableOllamaModels,
    updateProviderConfig
  } = useAppStore()

  const geminiConfig = providerConfigs.gemini
  const geminiApiKey = geminiConfig.apiKey
  const geminiBaseUrl = geminiConfig.baseUrl

  const ollamaConfig = providerConfigs.ollama
  const ollamaBaseUrl = ollamaConfig.baseUrl

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

  // Discover the models the local endpoint actually serves.
  //
  // The shipped list (llama3, mistral, …) can never contain what someone runs
  // locally, and the model name is a fixed dropdown — so a local model that is
  // not on that list is simply unselectable. Both shapes are accepted because
  // "Ollama-compatible" covers two dialects: Ollama's own {models:[{name}]}
  // and OpenAI's {data:[{id}]} (llama.cpp answers with both).
  useEffect(() => {
    if (!enabled) return

    const fetchOllamaModels = async () => {
      try {
        let list = await listLocalModelsDirect(ollamaBaseUrl)
        if (list.length === 0) {
          // The page is served over HTTPS in this setup, so the browser blocks
          // every plain-http local endpoint as mixed content — the fetch above
          // can never succeed there. The backend runs on the same host as the
          // model server and is same-origin for the page, so it can answer.
          list = await listLocalModelsViaBackend(ollamaBaseUrl)
        }
        if (list.length === 0) return
        setAvailableOllamaModels(list)
        // A stale name from a previous endpoint would 404 on every send.
        if (!list.includes(ollamaConfig.model)) {
          updateProviderConfig('ollama', { model: list[0] })
        }
      } catch {
        // No local server running is the normal case, not an error worth
        // showing: the dropdown falls back to the shipped list.
      }
    }
    fetchOllamaModels()
  }, [enabled, ollamaBaseUrl, setAvailableOllamaModels, updateProviderConfig, ollamaConfig.model])
}
