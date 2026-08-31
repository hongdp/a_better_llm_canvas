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

/**
 * Context windows the endpoint stated, keyed by model id. llama.cpp puts
 * `n_ctx` under each model's `meta`; our own backend proxy forwards it as
 * `contextWindows`. Anything else simply has none, and the table in
 * utils/contextWindow.ts answers instead.
 */
function normalizeContextWindows(data: unknown): Record<string, number> {
  const payload = (data ?? {}) as {
    data?: Array<{ id?: string; meta?: { n_ctx?: number } }>
    contextWindows?: Record<string, number>
  }
  if (payload.contextWindows && typeof payload.contextWindows === 'object') {
    return payload.contextWindows
  }
  const out: Record<string, number> = {}
  for (const entry of payload.data ?? []) {
    const n = entry?.meta?.n_ctx
    if (entry?.id && typeof n === 'number' && n > 0) out[entry.id] = n
  }
  return out
}

async function listLocalModelsDirect(baseUrl: string): Promise<{ names: string[]; windows: Record<string, number> }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`)
    if (!res.ok) return { names: [], windows: {} }
    const data = await res.json()
    return { names: normalizeModelList(data), windows: normalizeContextWindows(data) }
  } catch {
    return { names: [], windows: {} }
  }
}

async function listLocalModelsViaBackend(baseUrl: string): Promise<{ names: string[]; windows: Record<string, number> }> {
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': useAppStore.getState().csrfToken || ''
      },
      body: JSON.stringify({ baseUrl })
    })
    if (!res.ok) return { names: [], windows: {} }
    const data = await res.json()
    return { names: normalizeModelList(data), windows: normalizeContextWindows(data) }
  } catch {
    return { names: [], windows: {} }
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
    setAvailableRunpodModels,
    updateProviderConfig
  } = useAppStore()

  const geminiConfig = providerConfigs.gemini
  const geminiApiKey = geminiConfig.apiKey
  const geminiBaseUrl = geminiConfig.baseUrl

  const ollamaConfig = providerConfigs.ollama
  const ollamaBaseUrl = ollamaConfig.baseUrl

  const runpodConfig = providerConfigs.runpod
  const runpodBaseUrl = runpodConfig.baseUrl

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
        let listed = await listLocalModelsDirect(ollamaBaseUrl)
        if (listed.names.length === 0) {
          // The page is served over HTTPS in this setup, so the browser blocks
          // every plain-http local endpoint as mixed content — the fetch above
          // can never succeed there. The backend runs on the same host as the
          // model server and is same-origin for the page, so it can answer.
          listed = await listLocalModelsViaBackend(ollamaBaseUrl)
        }
        const list = listed.names
        if (list.length === 0) return
        setAvailableOllamaModels(list)
        if (Object.keys(listed.windows).length > 0) {
          useAppStore.getState().setDiscoveredContextWindows(listed.windows)
        }
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

  // Same discovery for the RunPod endpoint, against its own config slot.
  //
  // Two routes, and which one works depends on how the pod is addressed. A
  // tunnelled endpoint is plain http, so the browser blocks it as mixed
  // content and only the backend can answer. A pod addressed directly at
  // *.proxy.runpod.net is https, so the direct fetch succeeds (llama.cpp
  // serves CORS *) — and the backend can answer that one too, because
  // LOCAL_HOSTNAMES was widened to admit exactly that host suffix.
  useEffect(() => {
    if (!enabled) return

    const fetchRunpodModels = async () => {
      try {
        let listed = await listLocalModelsDirect(runpodBaseUrl)
        if (listed.names.length === 0) {
          listed = await listLocalModelsViaBackend(runpodBaseUrl)
        }
        const list = listed.names
        if (list.length === 0) return
        setAvailableRunpodModels(list)
        // The pod's llama.cpp states its n_ctx (262144 here) the same way the
        // local one does, and the context budgeter should believe it.
        if (Object.keys(listed.windows).length > 0) {
          useAppStore.getState().setDiscoveredContextWindows(listed.windows)
        }
        // A stale name from a previous pod would 404 on every send.
        if (!list.includes(runpodConfig.model)) {
          updateProviderConfig('runpod', { model: list[0] })
        }
      } catch {
        // A stopped pod is the normal case, not an error worth showing.
      }
    }
    fetchRunpodModels()
  }, [enabled, runpodBaseUrl, setAvailableRunpodModels, updateProviderConfig, runpodConfig.model])
}
