import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import { PROVIDER_MODELS } from '../types/llm'

const FALLBACK_GEMINI_MODELS = PROVIDER_MODELS.gemini
/** What a stale Gemini model setting is replaced with (2.5 and earlier are closed to new keys). */
const RECOMMENDED_GEMINI_MODEL = 'gemini-3.8-flash'

/** What a stale Claude model setting is replaced with (fast, and strong at long-form prose). */
const RECOMMENDED_CLAUDE_MODEL = 'claude-sonnet-5-5'
/** …and a stale OpenAI one (gpt-4o is not the default any more; it cannot reason). */
const RECOMMENDED_OPENAI_MODEL = 'gpt-5.5'

/** An official provider's model list for this key, through the backend (/api/models); [] on any failure. */
async function listOfficialModels(provider: 'anthropic' | 'openai' | 'gemini', apiKey: string, baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': useAppStore.getState().csrfToken || '' },
      body: JSON.stringify({ provider, apiKey, baseUrl })
    })
    return res.ok ? normalizeModelList(await res.json()) : []
  } catch (err) {
    console.error(`Failed to fetch ${provider} models`, err)
    return []
  }
}

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
    setAvailableAnthropicModels,
    setAvailableOpenAIModels,
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

  const openaiConfig = providerConfigs.openai
  const openaiApiKey = openaiConfig.apiKey
  const openaiBaseUrl = openaiConfig.baseUrl

  const anthropicConfig = providerConfigs.anthropic
  const anthropicApiKey = anthropicConfig.apiKey
  const anthropicBaseUrl = anthropicConfig.baseUrl

  const grokConfig = providerConfigs.grok
  const grokApiKey = grokConfig.apiKey
  const grokBaseUrl = grokConfig.baseUrl

  // Gemini's text models for this key, through the backend (/api/models): the
  // key stays out of URLs, and the list leaves out speech/image/music models
  // and 2.5, which Google still lists but refuses to new keys. A model the
  // list does not have is replaced by the recommended one.
  useEffect(() => {
    if (!enabled) return
    if (!geminiApiKey) {
      setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
      return
    }
    let cancelled = false
    setIsLoadingModels(true)
    void listOfficialModels('gemini', geminiApiKey, geminiBaseUrl).then(list => {
      if (cancelled) return
      setIsLoadingModels(false)
      if (list.length === 0) {
        setAvailableGeminiModels(FALLBACK_GEMINI_MODELS)
        setErrorMsg('Could not load the Gemini models for this key (check the key and base URL). Using the built-in list.')
        return
      }
      setAvailableGeminiModels(list)
      setErrorMsg(null)
      if (!list.includes(geminiConfig.model)) {
        updateProviderConfig('gemini', { model: list.includes(RECOMMENDED_GEMINI_MODEL) ? RECOMMENDED_GEMINI_MODEL : list[0] })
      }
    })
    return () => { cancelled = true }
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

  // The Claude models this key can use. Anthropic's API refuses calls from a
  // page (CORS), so the backend lists them. A model the list does not have
  // (an old default such as claude-3-5-sonnet, which is not a valid id) is
  // replaced by the recommended one, as the grok list does.
  useEffect(() => {
    if (!enabled || !anthropicApiKey) return
    let cancelled = false
    void listOfficialModels('anthropic', anthropicApiKey, anthropicBaseUrl).then(list => {
      if (cancelled || list.length === 0) return
      setAvailableAnthropicModels(list)
      if (!list.includes(anthropicConfig.model)) {
        updateProviderConfig('anthropic', { model: list.includes(RECOMMENDED_CLAUDE_MODEL) ? RECOMMENDED_CLAUDE_MODEL : list[0] })
      }
    })
    return () => { cancelled = true }
  }, [enabled, anthropicApiKey, anthropicBaseUrl, anthropicConfig.model, setAvailableAnthropicModels, updateProviderConfig])

  // OpenAI's text models for this key, the same way. Only for OpenAI's own
  // host: a compatible server under this provider keeps the shipped list.
  useEffect(() => {
    if (!enabled || !openaiApiKey || !/^https:\/\/api\.openai\.com\//.test(`${openaiBaseUrl}/`)) return
    let cancelled = false
    void listOfficialModels('openai', openaiApiKey, openaiBaseUrl).then(list => {
      if (cancelled || list.length === 0) return
      setAvailableOpenAIModels(list)
      if (!list.includes(openaiConfig.model)) {
        updateProviderConfig('openai', { model: list.includes(RECOMMENDED_OPENAI_MODEL) ? RECOMMENDED_OPENAI_MODEL : list[0] })
      }
    })
    return () => { cancelled = true }
  }, [enabled, openaiApiKey, openaiBaseUrl, openaiConfig.model, setAvailableOpenAIModels, updateProviderConfig])

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
