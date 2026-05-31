import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  X,
  Wand2,
  ImagePlus,
  ChevronDown,
  Settings2,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  AlertCircle,
  Check,
  Sparkles,
  FileText,
  StopCircle,
  RotateCcw,
  ChevronRight,
} from 'lucide-react'
import { generateImage, enhancePromptWithLLM, DEFAULT_IMAGE_STYLE_SYSTEM_PROMPT } from '../services/imageGen'
import type { ImageGenProvider } from '../services/imageGen'
import { useAppStore } from '../store/useAppStore'
import type { LLMProvider } from '../store/useAppStore'

interface ImageGenerationModalProps {
  isOpen: boolean
  onClose: () => void
  /** The currently selected text in the editor – pre-fills the prompt */
  initialPrompt?: string
  /** Plain-text content of the active document – used as additional context for LLM enhancement */
  documentContext?: string
  /** Called when the user clicks "Insert into Editor" */
  onInsertImage: (dataUrl: string, altText: string) => void
}

type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4'

const ASPECT_RATIOS: { label: string; value: AspectRatio; w: number; h: number }[] = [
  { label: '1:1', value: '1:1', w: 1024, h: 1024 },
  { label: '16:9', value: '16:9', w: 1792, h: 1024 },
  { label: '9:16', value: '9:16', w: 1024, h: 1792 },
  { label: '4:3', value: '4:3', w: 1024, h: 768 },
  { label: '3:4', value: '3:4', w: 768, h: 1024 },
]

const PROVIDER_LABELS: Record<ImageGenProvider, string> = {
  openai: 'DALL·E',
  gemini: 'Imagen',
  stabilityai: 'Stability',
  grok: 'Grok Image',
}

const PROVIDER_FULL_LABELS: Record<ImageGenProvider, string> = {
  openai: 'OpenAI DALL·E',
  gemini: 'Google Imagen',
  stabilityai: 'Stability AI',
  grok: 'Grok Image (xAI)',
}

// Which LLM provider config shares an API key with each image provider
// e.g. Grok image generation → use providerConfigs.grok.apiKey
const PROVIDER_TO_LLM: Partial<Record<ImageGenProvider, LLMProvider>> = {
  openai: 'openai',
  gemini: 'gemini',
  grok: 'grok',
  // stabilityai has no LLM counterpart — uses its own dedicated key
}

const ALL_MODELS: Record<ImageGenProvider, string[]> = {
  openai: ['dall-e-3', 'dall-e-2', 'gpt-image-1'],
  gemini: ['imagen-3.0-generate-001', 'imagen-3.0-fast-generate-001'],
  stabilityai: ['stable-diffusion-xl-1024-v1-0', 'stable-diffusion-v1-6', 'stable-image-core', 'stable-image-ultra'],
  grok: ['grok-2-image', 'grok-imagine-image-quality'],
}

// ── Model discovery ──────────────────────────────────────────────────────────
// Known image-generation model name patterns per provider (for filtering /v1/models)
const IMAGE_MODEL_PATTERNS: Record<ImageGenProvider, RegExp> = {
  openai:     /dall-e|gpt-image|imagen/i,
  gemini:     /imagen/i,
  stabilityai:/stable/i,
  grok:       /grok.*image|aurora|imagine/i,
}

async function fetchImageModels(
  provider: ImageGenProvider,
  apiKey: string,
  baseUrl?: string
): Promise<string[]> {
  const fallback = ALL_MODELS[provider]

  try {
    if (provider === 'gemini') {
      // Gemini uses its own models API
      const base = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
      const res = await fetch(`${base}/models?key=${apiKey}`)
      if (!res.ok) return fallback
      const data = await res.json()
      const models = (data.models || [])
        .filter((m: any) =>
          (m.supportedGenerationMethods || []).some((method: string) =>
            method.toLowerCase().includes('generate') || method.toLowerCase().includes('predict')
          ) && IMAGE_MODEL_PATTERNS.gemini.test(m.name)
        )
        .map((m: any) => m.name.startsWith('models/') ? m.name.slice(7) : m.name)
      return models.length ? models : fallback
    }

    if (provider === 'stabilityai') {
      // Stability AI has an engines endpoint
      const base = (baseUrl || 'https://api.stability.ai').replace(/\/$/, '')
      const res = await fetch(`${base}/v1/engines/list`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      })
      if (!res.ok) return fallback
      const data = await res.json()
      const ids = (Array.isArray(data) ? data : [])
        .map((e: any) => e.id as string)
        .filter(Boolean)
      return ids.length ? ids : fallback
    }

    // OpenAI-compatible endpoint (openai + grok)
    const base = (
      baseUrl ||
      (provider === 'grok' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1')
    ).replace(/\/$/, '')
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    })
    if (!res.ok) return fallback
    const data = await res.json()
    const pattern = IMAGE_MODEL_PATTERNS[provider]
    const models = (data.data || [])
      .map((m: any) => m.id as string)
      .filter((id: string) => pattern.test(id))
      .sort()
    return models.length ? models : fallback
  } catch {
    return fallback
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function textareaStyle(focused: boolean = false): React.CSSProperties {
  return {
    width: '100%',
    padding: '0.6rem 0.75rem',
    borderRadius: '8px',
    border: `1px solid ${focused ? 'var(--accent)' : 'var(--border-color)'}`,
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: '0.855rem',
    resize: 'vertical' as const,
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: 1.55,
    boxSizing: 'border-box' as const,
    transition: 'border-color 0.18s',
  }
}

function sectionLabel(text: string, sub?: string) {
  return (
    <label style={{ display: 'block', marginBottom: '0.35rem' }}>
      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{text}</span>
      {sub && <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginLeft: '0.4rem' }}>{sub}</span>}
    </label>
  )
}

function pillBtn(active: boolean, onClick: () => void, label: string) {
  return (
    <button
      key={label}
      type="button"
      onClick={onClick}
      style={{
        padding: '3px 10px',
        borderRadius: '6px',
        fontSize: '0.775rem',
        border: active ? '1px solid var(--accent)' : '1px solid var(--border-color)',
        backgroundColor: active ? 'rgba(245, 158, 11, 0.15)' : 'var(--bg-tertiary)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        cursor: 'pointer',
        transition: 'all 0.15s',
        fontWeight: active ? 600 : 400,
        whiteSpace: 'nowrap' as const,
      }}
    >
      {label}
    </button>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export const ImageGenerationModal: React.FC<ImageGenerationModalProps> = ({
  isOpen,
  onClose,
  initialPrompt = '',
  documentContext = '',
  onInsertImage,
}) => {
  const {
    imageGenConfig, updateImageGenConfig,
    activeProvider, providerConfigs,
  } = useAppStore()

  // ── Input fields ──
  const [rawPrompt, setRawPrompt] = useState(initialPrompt)
  const [context, setContext] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1')
  const [style, setStyle] = useState<'vivid' | 'natural'>('vivid')

  // ── LLM Enhancement ──
  const [enhancedPrompt, setEnhancedPrompt] = useState('')
  const [isEnhancing, setIsEnhancing] = useState(false)
  const [enhanceError, setEnhanceError] = useState<string | null>(null)
  const enhanceAbortRef = useRef<AbortController | null>(null)

  // ── Image Generation ──
  const [isGenerating, setIsGenerating] = useState(false)
  const [generatedImage, setGeneratedImage] = useState<string | null>(null)
  const [revisedPrompt, setRevisedPrompt] = useState<string | null>(null)
  const [genError, setGenError] = useState<string | null>(null)

  // ── UI ──
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showStylePrompt, setShowStylePrompt] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [insertSuccess, setInsertSuccess] = useState(false)
  const [promptFocused, setPromptFocused] = useState(false)
  const [contextFocused, setContextFocused] = useState(false)
  const [enhFocused, setEnhFocused] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  // ── Model discovery ──
  const [discoveredModels, setDiscoveredModels] = useState<string[] | null>(null)
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)

  // Reset when modal opens
  useEffect(() => {
    if (isOpen) {
      setRawPrompt(initialPrompt || '')
      setContext(documentContext ? documentContext.slice(0, 800) : '')
      setEnhancedPrompt('')
      setEnhanceError(null)
      setGeneratedImage(null)
      setRevisedPrompt(null)
      setGenError(null)
      setInsertSuccess(false)
      setZoom(1)
      setTimeout(() => promptRef.current?.focus(), 100)
    } else {
      // Cancel any in-flight enhancement when modal closes
      enhanceAbortRef.current?.abort()
    }
  }, [isOpen, initialPrompt, documentContext])

  // Derived values needed by hooks below — must be computed before any early return
  const provider = imageGenConfig.provider
  const sharedLlmProvider = PROVIDER_TO_LLM[provider]
  const sharedApiKey = sharedLlmProvider ? providerConfigs[sharedLlmProvider]?.apiKey : ''
  const effectiveApiKey = sharedApiKey || imageGenConfig.apiKey
  const usingSharedKey = Boolean(sharedApiKey)

  // ── Model Discovery hooks (must be before early return) ──

  const handleDiscoverModels = useCallback(async () => {
    if (!effectiveApiKey) {
      setDiscoverError('Add an API key first to discover available models.')
      return
    }
    setIsDiscovering(true)
    setDiscoverError(null)
    try {
      const models = await fetchImageModels(provider, effectiveApiKey, imageGenConfig.baseUrl)
      setDiscoveredModels(models)
      const currentModel = imageGenConfig.model || ALL_MODELS[provider][0]
      if (!models.includes(currentModel)) {
        updateImageGenConfig({ model: models[0] })
      }
    } catch (err: any) {
      setDiscoverError(err.message || 'Failed to fetch models.')
    } finally {
      setIsDiscovering(false)
    }
  }, [provider, effectiveApiKey, imageGenConfig.baseUrl, imageGenConfig.model, updateImageGenConfig])

  // Auto-discover when the advanced panel opens (and key is available)
  useEffect(() => {
    if (showAdvanced && effectiveApiKey && !discoveredModels && !isDiscovering) {
      handleDiscoverModels()
    }
  }, [showAdvanced, effectiveApiKey, provider]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset discovered models when provider changes
  useEffect(() => {
    setDiscoveredModels(null)
    setDiscoverError(null)
  }, [provider])

  if (!isOpen) return null

  const selectedAspect = ASPECT_RATIOS.find(r => r.value === aspectRatio) ?? ASPECT_RATIOS[0]
  const llmConfig = { ...providerConfigs[activeProvider], provider: activeProvider }
  const stylePromptText = imageGenConfig.styleSystemPrompt || DEFAULT_IMAGE_STYLE_SYSTEM_PROMPT
  const llmEnhancementEnabled = imageGenConfig.llmEnhancementEnabled !== false

  // The models to show in the dropdown — discovered list takes priority over static fallback
  const availableModels = discoveredModels ?? ALL_MODELS[provider]

  // The final prompt sent to image API – enhanced if available, else raw
  const finalPrompt = enhancedPrompt.trim() || rawPrompt.trim()

  // ── Handlers ──

  const handleEnhancePrompt = async () => {
    if (!rawPrompt.trim()) {
      setEnhanceError('Enter a prompt first.')
      return
    }
    if (!providerConfigs[activeProvider].apiKey && activeProvider !== 'ollama') {
      setEnhanceError(`No API key for the active LLM (${activeProvider}). Configure it in Settings.`)
      return
    }

    setIsEnhancing(true)
    setEnhancedPrompt('')
    setEnhanceError(null)
    const abortController = new AbortController()
    enhanceAbortRef.current = abortController

    try {
      const result = await enhancePromptWithLLM(
        rawPrompt,
        context,
        stylePromptText,
        llmConfig,
        (chunk) => setEnhancedPrompt(prev => prev + chunk),
        abortController.signal
      )
      setEnhancedPrompt(result)
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('abort')) return
      setEnhanceError(err.message || 'Failed to enhance prompt. Check your LLM settings.')
    } finally {
      setIsEnhancing(false)
      enhanceAbortRef.current = null
    }
  }

  const handleGenerate = async () => {
    if (!finalPrompt) {
      setGenError('Please enter a prompt first.')
      return
    }
    if (!effectiveApiKey) {
      setGenError(`No API key for ${PROVIDER_FULL_LABELS[provider]}. ${sharedLlmProvider ? `Add a ${sharedLlmProvider} API key in Settings.` : 'Add it in the Advanced panel below.'}`)
      return
    }

    setIsGenerating(true)
    setGeneratedImage(null)
    setRevisedPrompt(null)
    setGenError(null)

    const promptToSend = negativePrompt.trim()
      ? `${finalPrompt}. Avoid: ${negativePrompt.trim()}`
      : finalPrompt

    try {
      const result = await generateImage(promptToSend, {
        provider,
        apiKey: effectiveApiKey,
        model: imageGenConfig.model || ALL_MODELS[provider][0],
        baseUrl: imageGenConfig.baseUrl,
        width: selectedAspect.w,
        height: selectedAspect.h,
        style: provider === 'openai' ? style : undefined,
      })
      setGeneratedImage(result.dataUrl)
      if (result.revisedPrompt) setRevisedPrompt(result.revisedPrompt)
    } catch (err: any) {
      setGenError(err.message || 'Image generation failed. Please check your API key and try again.')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleInsert = () => {
    if (!generatedImage) return
    onInsertImage(generatedImage, finalPrompt.slice(0, 120))
    setInsertSuccess(true)
    setTimeout(onClose, 600)
  }

  // ── Render helpers ──

  const accentBtnStyle = (disabled: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem',
    padding: '0.55rem 1.1rem', borderRadius: '8px', border: 'none',
    background: disabled ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, var(--accent), #f97316)',
    color: disabled ? 'var(--text-muted)' : 'white',
    fontSize: '0.875rem', fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.18s',
    boxShadow: disabled ? 'none' : '0 3px 12px rgba(245, 158, 11, 0.35)',
    flex: '0 0 auto',
  })

  const secondaryBtnStyle = (disabled = false): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '0.4rem',
    padding: '0.5rem 0.9rem', borderRadius: '8px',
    border: '1px solid var(--border-color)',
    backgroundColor: 'var(--bg-tertiary)',
    color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
    fontSize: '0.82rem', fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s',
    flex: '0 0 auto',
  })

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label="AI Image Generation"
    >
      <div
        className="modal-content glass-panel"
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: generatedImage ? '900px' : '600px',
          width: '96vw',
          border: '1px solid var(--border-color)',
          backgroundColor: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          transition: 'max-width 0.3s ease',
          display: 'flex',
          flexDirection: 'column',
          gap: '0',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: '0',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1rem 1.25rem 0.85rem',
          borderBottom: '1px solid var(--border-color)',
          position: 'sticky', top: 0, zIndex: 10,
          backgroundColor: 'var(--bg-secondary)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{
              width: 34, height: 34, borderRadius: '9px',
              background: 'linear-gradient(135deg, var(--accent), #f97316)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(245, 158, 11, 0.35)',
            }}>
              <Wand2 size={17} style={{ color: 'white' }} />
            </div>
            <div>
              <div style={{ fontSize: '0.975rem', fontWeight: 700 }}>AI Image Generation</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '1px' }}>
                LLM prompt enhancement → image generation → insert to editor
              </div>
            </div>
          </div>
          <button onClick={onClose} className="btn-icon" title="Close" type="button">
            <X size={18} />
          </button>
        </div>

        {/* ── Body ── */}
        <div style={{ display: 'flex', gap: '0', flex: 1 }}>

          {/* ──── Left column: Controls ──── */}
          <div style={{
            flex: 1, minWidth: '280px',
            display: 'flex', flexDirection: 'column', gap: '0',
            padding: '1rem 1.25rem',
            overflowY: 'auto',
          }}>

            {/* ═══ STEP 1 – Input ═══ */}
            <div style={{
              borderRadius: '10px',
              border: '1px solid var(--border-color)',
              overflow: 'hidden',
              marginBottom: '0.875rem',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.6rem 0.85rem',
                backgroundColor: 'var(--bg-tertiary)',
                borderBottom: '1px solid var(--border-color)',
              }}>
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  background: 'var(--accent)', color: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.7rem', fontWeight: 700, flexShrink: 0,
                }}>1</div>
                <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>Input &amp; Context</span>
              </div>
              <div style={{ padding: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>

                {/* Raw prompt */}
                <div>
                  {sectionLabel('Image Prompt')}
                  <textarea
                    ref={promptRef}
                    value={rawPrompt}
                    onChange={e => setRawPrompt(e.target.value)}
                    placeholder="Describe the image you want to generate…"
                    rows={3}
                    style={textareaStyle(promptFocused)}
                    onFocus={() => setPromptFocused(true)}
                    onBlur={() => setPromptFocused(false)}
                  />
                </div>

                {/* Additional context */}
                <div>
                  {sectionLabel('Additional Context', '(from document — helps LLM enrich the prompt)')}
                  <textarea
                    value={context}
                    onChange={e => setContext(e.target.value)}
                    placeholder="Paste relevant document excerpt or describe the scene context…"
                    rows={2}
                    style={textareaStyle(contextFocused)}
                    onFocus={() => setContextFocused(true)}
                    onBlur={() => setContextFocused(false)}
                  />
                </div>

                {/* Style system prompt toggle */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowStylePrompt(v => !v)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '5px',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-secondary)', fontSize: '0.78rem', padding: '0',
                    }}
                  >
                    <Settings2 size={13} />
                    LLM Enhancement Style Prompt
                    <ChevronDown size={12} style={{ transform: showStylePrompt ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                  </button>
                  {showStylePrompt && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <textarea
                        value={imageGenConfig.styleSystemPrompt ?? ''}
                        onChange={e => updateImageGenConfig({ styleSystemPrompt: e.target.value })}
                        placeholder={DEFAULT_IMAGE_STYLE_SYSTEM_PROMPT}
                        rows={5}
                        style={{ ...textareaStyle(), fontSize: '0.78rem', fontFamily: 'monospace' }}
                      />
                      <button
                        type="button"
                        onClick={() => updateImageGenConfig({ styleSystemPrompt: '' })}
                        style={{ ...secondaryBtnStyle(), marginTop: '0.35rem', fontSize: '0.74rem', padding: '3px 8px' }}
                      >
                        <RotateCcw size={11} /> Reset to default
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ═══ STEP 2 – LLM Enhancement ═══ */}
            <div style={{
              borderRadius: '10px',
              border: `1px solid ${enhancedPrompt ? 'var(--accent)' : 'var(--border-color)'}`,
              overflow: 'hidden',
              marginBottom: '0.875rem',
              transition: 'border-color 0.2s',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.6rem 0.85rem',
                backgroundColor: enhancedPrompt ? 'rgba(245, 158, 11, 0.07)' : 'var(--bg-tertiary)',
                borderBottom: '1px solid var(--border-color)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%',
                    background: enhancedPrompt ? 'var(--accent)' : 'var(--bg-secondary)',
                    border: enhancedPrompt ? 'none' : '1.5px solid var(--border-color)',
                    color: enhancedPrompt ? 'white' : 'var(--text-muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.7rem', fontWeight: 700, flexShrink: 0, transition: 'all 0.2s',
                  }}>2</div>
                  <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>LLM Prompt Enhancement</span>
                  <span style={{
                    fontSize: '0.7rem', padding: '1px 6px', borderRadius: '4px',
                    backgroundColor: llmEnhancementEnabled ? 'rgba(16,185,129,0.15)' : 'var(--bg-secondary)',
                    color: llmEnhancementEnabled ? '#10b981' : 'var(--text-muted)',
                    border: `1px solid ${llmEnhancementEnabled ? 'rgba(16,185,129,0.3)' : 'var(--border-color)'}`,
                    cursor: 'pointer', userSelect: 'none',
                  }}
                    onClick={() => updateImageGenConfig({ llmEnhancementEnabled: !llmEnhancementEnabled })}
                  >
                    {llmEnhancementEnabled ? 'ON' : 'OFF'}
                  </span>
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  via {activeProvider} / {providerConfigs[activeProvider].model}
                </span>
              </div>

              <div style={{ padding: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <textarea
                      value={enhancedPrompt}
                      onChange={e => setEnhancedPrompt(e.target.value)}
                      placeholder={llmEnhancementEnabled
                        ? `Click "✦ Enhance" to rewrite your prompt with ${activeProvider}…`
                        : 'LLM enhancement is disabled. The raw prompt will be used directly.'}
                      rows={4}
                      disabled={!llmEnhancementEnabled || isEnhancing}
                      style={{
                        ...textareaStyle(enhFocused),
                        opacity: !llmEnhancementEnabled ? 0.5 : 1,
                        fontStyle: isEnhancing && !enhancedPrompt ? 'italic' : 'normal',
                      }}
                      onFocus={() => setEnhFocused(true)}
                      onBlur={() => setEnhFocused(false)}
                    />
                    {enhancedPrompt && !isEnhancing && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '0.3rem' }}>
                        <Check size={12} style={{ color: '#10b981' }} />
                        <span style={{ fontSize: '0.72rem', color: '#10b981' }}>Enhanced prompt ready — you can edit it</span>
                      </div>
                    )}
                  </div>
                </div>

                {enhanceError && (
                  <div style={{
                    display: 'flex', gap: '0.4rem', alignItems: 'flex-start',
                    padding: '0.5rem 0.65rem', borderRadius: '7px',
                    backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
                    color: '#f87171', fontSize: '0.79rem',
                  }}>
                    <AlertCircle size={13} style={{ flexShrink: 0, marginTop: '2px' }} />
                    <span>{enhanceError}</span>
                  </div>
                )}

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {llmEnhancementEnabled && (
                    isEnhancing ? (
                      <button
                        type="button"
                        onClick={() => { enhanceAbortRef.current?.abort(); setIsEnhancing(false) }}
                        style={secondaryBtnStyle()}
                      >
                        <StopCircle size={14} style={{ color: '#ef4444' }} /> Stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleEnhancePrompt}
                        disabled={!rawPrompt.trim()}
                        style={accentBtnStyle(!rawPrompt.trim())}
                      >
                        <Sparkles size={14} /> Enhance Prompt
                      </button>
                    )
                  )}
                  {enhancedPrompt && (
                    <button
                      type="button"
                      onClick={() => setEnhancedPrompt('')}
                      style={secondaryBtnStyle()}
                    >
                      <RotateCcw size={13} /> Use raw
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* ═══ STEP 3 – Image Generation Options ═══ */}
            <div style={{
              borderRadius: '10px',
              border: '1px solid var(--border-color)',
              overflow: 'hidden',
              marginBottom: '0.875rem',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.6rem 0.85rem',
                backgroundColor: 'var(--bg-tertiary)',
                borderBottom: '1px solid var(--border-color)',
              }}>
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  background: 'var(--bg-secondary)',
                  border: '1.5px solid var(--border-color)',
                  color: 'var(--text-muted)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.7rem', fontWeight: 700, flexShrink: 0,
                }}>3</div>
                <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>Image Options &amp; Provider</span>
              </div>
              <div style={{ padding: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

                {/* Aspect Ratio */}
                <div>
                  {sectionLabel('Aspect Ratio')}
                  <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                    {ASPECT_RATIOS.map(r => pillBtn(aspectRatio === r.value, () => setAspectRatio(r.value), r.label))}
                  </div>
                </div>

                {/* Provider */}
                <div>
                  {sectionLabel('Image Provider')}
                  <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                    {(Object.keys(PROVIDER_LABELS) as ImageGenProvider[]).map(p =>
                      pillBtn(provider === p, () => updateImageGenConfig({ provider: p, model: ALL_MODELS[p][0] }), PROVIDER_LABELS[p])
                    )}
                  </div>
                </div>

                {/* Advanced Settings Toggle */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(v => !v)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '5px',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-secondary)', fontSize: '0.78rem', padding: '0',
                    }}
                  >
                    <Settings2 size={13} />
                    Advanced Options
                    <ChevronDown size={12} style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                  </button>

                  {showAdvanced && (
                    <div style={{
                      marginTop: '0.6rem', padding: '0.75rem',
                      borderRadius: '8px', border: '1px solid var(--border-color)',
                      backgroundColor: 'var(--bg-tertiary)',
                      display: 'flex', flexDirection: 'column', gap: '0.65rem',
                    }}>
                      {/* Model */}
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Model</span>
                            {discoveredModels && (
                              <span style={{ fontSize: '0.68rem', color: '#10b981', background: 'rgba(16,185,129,0.1)', borderRadius: '4px', padding: '1px 5px' }}>
                                {discoveredModels.length} discovered
                              </span>
                            )}
                          </label>
                          <button
                            type="button"
                            title="Discover available models from API"
                            onClick={handleDiscoverModels}
                            disabled={isDiscovering || !effectiveApiKey}
                            style={{
                              display: 'flex', alignItems: 'center', gap: '3px',
                              background: 'none', border: '1px solid var(--border-color)',
                              borderRadius: '5px', cursor: effectiveApiKey ? 'pointer' : 'not-allowed',
                              color: 'var(--text-secondary)', fontSize: '0.72rem',
                              padding: '2px 7px', opacity: effectiveApiKey ? 1 : 0.45,
                            }}
                          >
                            <RefreshCw size={10} style={{ animation: isDiscovering ? 'spin 1s linear infinite' : 'none' }} />
                            {isDiscovering ? 'Loading…' : 'Refresh'}
                          </button>
                        </div>
                        <select
                          className="select-styled"
                          value={imageGenConfig.model || availableModels[0]}
                          onChange={e => updateImageGenConfig({ model: e.target.value })}
                          style={{ width: '100%', fontSize: '0.82rem' }}
                        >
                          {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                        {discoverError && (
                          <div style={{ fontSize: '0.72rem', color: '#f87171', marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <AlertCircle size={11} /> {discoverError}
                          </div>
                        )}
                      </div>


                      {/* API Key */}
                      <div>
                        {sectionLabel('API Key', `(for ${PROVIDER_FULL_LABELS[provider]})`)}
                        {usingSharedKey ? (
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                            padding: '0.45rem 0.7rem', borderRadius: '6px',
                            border: '1px solid rgba(16, 185, 129, 0.3)',
                            backgroundColor: 'rgba(16, 185, 129, 0.08)',
                            fontSize: '0.8rem', color: '#10b981',
                          }}>
                            <Check size={13} />
                            <span>Using <strong>{sharedLlmProvider}</strong> API key from Settings — no separate key needed</span>
                          </div>
                        ) : (
                          <input
                            type="password"
                            value={imageGenConfig.apiKey}
                            onChange={e => updateImageGenConfig({ apiKey: e.target.value })}
                            placeholder={`Enter ${PROVIDER_FULL_LABELS[provider]} API key`}
                            style={{
                              width: '100%', padding: '0.42rem 0.65rem', borderRadius: '6px',
                              border: '1px solid var(--border-color)', outline: 'none',
                              backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)',
                              fontSize: '0.82rem', fontFamily: 'monospace', boxSizing: 'border-box',
                            }}
                          />
                        )}
                      </div>

                      {/* Base URL */}
                      <div>
                        {sectionLabel('Custom Base URL', '(optional)')}
                        <input
                          type="text"
                          value={imageGenConfig.baseUrl || ''}
                          onChange={e => updateImageGenConfig({ baseUrl: e.target.value })}
                          placeholder={
                            provider === 'grok' ? 'https://api.x.ai/v1' :
                            provider === 'openai' ? 'https://api.openai.com/v1' :
                            'Default endpoint'
                          }
                          style={{
                            width: '100%', padding: '0.42rem 0.65rem', borderRadius: '6px',
                            border: '1px solid var(--border-color)', outline: 'none',
                            backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)',
                            fontSize: '0.82rem', fontFamily: 'monospace', boxSizing: 'border-box',
                          }}
                        />
                      </div>

                      {/* Style (DALL·E 3 only) */}
                      {provider === 'openai' && (
                        <div>
                          {sectionLabel('Style', '(DALL·E 3 only)')}
                          <div style={{ display: 'flex', gap: '5px' }}>
                            {(['vivid', 'natural'] as const).map(s =>
                              pillBtn(style === s, () => setStyle(s), s.charAt(0).toUpperCase() + s.slice(1))
                            )}
                          </div>
                        </div>
                      )}

                      {/* Negative Prompt */}
                      <div>
                        {sectionLabel('Negative Prompt', '(what to avoid)')}
                        <textarea
                          value={negativePrompt}
                          onChange={e => setNegativePrompt(e.target.value)}
                          placeholder="blurry, low quality, distorted, watermark…"
                          rows={2}
                          style={{ ...textareaStyle(), fontSize: '0.82rem' }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Active prompt preview */}
                {finalPrompt && (
                  <div style={{
                    padding: '0.55rem 0.7rem', borderRadius: '7px',
                    backgroundColor: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-color)',
                    fontSize: '0.78rem', color: 'var(--text-secondary)',
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: '0.2rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <FileText size={12} />
                      {enhancedPrompt ? 'Enhanced prompt' : 'Raw prompt'} will be sent to {PROVIDER_FULL_LABELS[provider]}
                    </div>
                    <div style={{ color: 'var(--text-primary)', fontSize: '0.8rem', lineHeight: 1.45 }}>
                      {finalPrompt.length > 200 ? finalPrompt.slice(0, 200) + '…' : finalPrompt}
                    </div>
                  </div>
                )}

                {/* Gen error */}
                {genError && (
                  <div style={{
                    display: 'flex', gap: '0.4rem', alignItems: 'flex-start',
                    padding: '0.55rem 0.7rem', borderRadius: '7px',
                    backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
                    color: '#f87171', fontSize: '0.8rem',
                  }}>
                    <AlertCircle size={13} style={{ flexShrink: 0, marginTop: '2px' }} />
                    <span>{genError}</span>
                  </div>
                )}

                {/* Generate button */}
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={isGenerating || !finalPrompt || isEnhancing}
                  style={{
                    ...accentBtnStyle(isGenerating || !finalPrompt || isEnhancing),
                    fontSize: '0.9rem', padding: '0.65rem 1.25rem', width: '100%',
                  }}
                >
                  {isGenerating ? (
                    <><RefreshCw size={15} className="animate-spin" /> Generating image…</>
                  ) : (
                    <><ChevronRight size={15} /> Generate Image <span style={{ fontSize: '0.72rem', opacity: 0.75 }}>(Ctrl+Enter)</span></>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* ──── Right column: Image Preview ──── */}
          {generatedImage && (
            <div style={{
              flex: '0 0 320px',
              display: 'flex', flexDirection: 'column', gap: '0.75rem',
              padding: '1rem 1.25rem 1rem 0',
              borderLeft: '1px solid var(--border-color)',
              paddingLeft: '1.25rem',
              overflowY: 'auto',
            }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Generated Image</div>

              <div style={{
                borderRadius: '10px', overflow: 'hidden',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-tertiary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <img
                  src={generatedImage}
                  alt="Generated"
                  style={{
                    width: '100%', height: 'auto', maxHeight: '360px',
                    objectFit: 'contain',
                    transform: `scale(${zoom})`, transformOrigin: 'center',
                    transition: 'transform 0.2s', display: 'block',
                  }}
                />
              </div>

              {/* Zoom Controls */}
              <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                <button type="button" onClick={() => setZoom(z => Math.max(0.5, z - 0.1))} className="btn-icon" style={{ padding: '4px' }}>
                  <ZoomOut size={13} />
                </button>
                <span style={{ fontSize: '0.77rem', color: 'var(--text-secondary)', minWidth: '2.8rem', textAlign: 'center' }}>
                  {Math.round(zoom * 100)}%
                </span>
                <button type="button" onClick={() => setZoom(z => Math.min(2.5, z + 0.1))} className="btn-icon" style={{ padding: '4px' }}>
                  <ZoomIn size={13} />
                </button>
                <button type="button" onClick={() => setZoom(1)} className="btn-icon" style={{ padding: '3px 6px', fontSize: '0.72rem' }}>1:1</button>
              </div>

              {/* Revised Prompt Badge */}
              {revisedPrompt && (
                <div style={{
                  padding: '0.55rem 0.7rem', borderRadius: '7px',
                  backgroundColor: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                  fontSize: '0.77rem', color: 'var(--text-secondary)',
                }}>
                  <span style={{ fontWeight: 600, color: 'var(--accent)', display: 'block', marginBottom: '0.2rem' }}>
                    Provider-revised prompt:
                  </span>
                  {revisedPrompt}
                </div>
              )}

              {/* Insert Button */}
              <button
                type="button"
                onClick={handleInsert}
                disabled={insertSuccess}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  padding: '0.6rem 1.2rem', borderRadius: '9px', border: 'none', width: '100%',
                  background: '#10b981', color: 'white',
                  fontSize: '0.88rem', fontWeight: 600,
                  cursor: insertSuccess ? 'default' : 'pointer',
                  transition: 'all 0.2s',
                  boxShadow: '0 3px 10px rgba(16, 185, 129, 0.3)',
                }}
              >
                {insertSuccess ? <><Check size={15} /> Inserted!</> : <><ImagePlus size={15} /> Insert into Editor</>}
              </button>

              {/* Regenerate hint */}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isGenerating}
                style={secondaryBtnStyle(isGenerating)}
              >
                <RefreshCw size={13} className={isGenerating ? 'animate-spin' : ''} />
                {isGenerating ? 'Regenerating…' : 'Regenerate'}
              </button>

              <p style={{ fontSize: '0.73rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>
                Edit the prompt above and regenerate, or enhance again.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
