import React, { useState } from 'react'
import { X, Key, Shield, HelpCircle, Save, Plus, Trash2, Edit, AlertCircle, ShieldAlert, Image, RotateCcw } from 'lucide-react'
import { useAppStore, type LLMProvider, PROVIDER_MODELS, DEFAULT_IMAGE_ANALYSIS_PROMPT } from '../store/useAppStore'
import { useTranslation } from '../i18n'
import { useModelFetcher } from '../hooks/useModelFetcher'
import { supportsReasoningEffort, supportedReasoningEfforts, DEFAULT_REASONING_EFFORT } from '../utils/reasoningEffort'
import { autoProtocolFor } from '../utils/protocolChoice'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { 
    activeProvider,
    setProvider,
    providerConfigs, 
    updateProviderConfig,
    availableGeminiModels,
    availableGrokModels,
    availableOllamaModels,
    summaryProvider,
    setSummaryProvider,
    customSystemPrompts,
    addSystemPrompt,
    updateSystemPrompt,
    deleteSystemPrompt,
    activeSystemPromptId,
    setActiveSystemPromptId,
    debugMode,
    setDebugMode,
    imageAnalysisPrompt,
    setImageAnalysisPrompt
  } = useAppStore()

  const { t } = useTranslation()

  const [activeTab, setActiveTab] = React.useState<LLMProvider>('gemini')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [, setIsLoadingModels] = useState(false)

  useModelFetcher(isOpen, setErrorMsg, setIsLoadingModels)

  // Set the default tab to the active provider when the modal opens (and keep
  // it following external active-provider changes while open). Implemented as
  // the "adjust state during render" pattern to avoid setState-in-effect.
  const [prevTabSync, setPrevTabSync] = React.useState<{ isOpen: boolean; provider: LLMProvider }>({ isOpen: false, provider: activeProvider })
  if (prevTabSync.isOpen !== isOpen || prevTabSync.provider !== activeProvider) {
    setPrevTabSync({ isOpen, provider: activeProvider })
    if (isOpen) {
      setActiveTab(activeProvider)
    }
  }

  if (!isOpen) return null

  const currentConfig = providerConfigs[activeTab] || providerConfigs.gemini
  const geminiConfig = providerConfigs.gemini

  const handleConfigChange = (field: 'apiKey' | 'baseUrl' | 'maxOutputTokens' | 'model' | 'summaryModel' | 'reasoningEffort' | 'documentProtocol', value: string | number) => {
    updateProviderConfig(activeTab, { [field]: value })
  }

  const labels: Record<LLMProvider, string> = {
    gemini: 'Gemini',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    ollama: 'Ollama (Local)',
    grok: 'Grok (xAI)'
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div 
        className="modal-content glass-panel" 
        onClick={(e) => e.stopPropagation()}
        style={{
          border: '1px solid var(--border-color)',
          backgroundColor: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          maxWidth: '560px'
        }}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Shield size={18} style={{ color: 'var(--accent)' }} />
            <h3>{`${labels[activeTab]} ${t.settings.title}`}</h3>
          </div>
          <button onClick={onClose} className="btn-icon" title="Close" type="button">
            <X size={18} />
          </button>
        </div>

        {/* Selection Tabs */}
        <div className="settings-tabs" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {(['gemini', 'openai', 'anthropic', 'ollama', 'grok'] as const).map((prov) => (
            <button
              key={prov}
              onClick={() => setActiveTab(prov)}
              type="button"
              className={`settings-tab-btn ${activeTab === prov ? 'active' : ''}`}
            >
              {labels[prov].replace(' (Local)', '').replace(' (xAI)', '')}
            </button>
          ))}
        </div>

        <div className="modal-body" style={{ maxHeight: '48vh', overflowY: 'auto', paddingRight: '0.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Error Alert Display */}
          {errorMsg && (
            <div style={{
              padding: '0.75rem',
              borderRadius: '8px',
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#f87171',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.5rem'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AlertCircle size={16} style={{ flexShrink: 0 }} />
                <span>{errorMsg}</span>
              </div>
              <button 
                onClick={() => setErrorMsg(null)} 
                className="btn-icon" 
                title="Dismiss error"
                type="button"
                style={{ padding: '2px', color: '#f87171' }}
              >
                <X size={14} />
              </button>
            </div>
          )}

            <>
              {/* Active Provider Toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Active LLM Provider</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {activeProvider === activeTab ? 'This provider is currently active.' : 'Configure and set as current provider.'}
                  </span>
                </div>
                {activeProvider === activeTab ? (
                  <span style={{ 
                    fontSize: '0.75rem', 
                    fontWeight: 600, 
                    color: 'var(--accent)', 
                    backgroundColor: 'rgba(var(--accent-rgb), 0.1)', 
                    padding: '0.25rem 0.5rem', 
                    borderRadius: '4px',
                    border: '1px solid var(--accent)'
                  }}>
                    Active
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setProvider(activeTab as LLMProvider)}
                    className="btn-primary"
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.6rem', borderRadius: '6px' }}
                  >
                    Set Active
                  </button>
                )}
              </div>

              {/* Model Selector Dropdown */}
              <div className="form-group">
                <label htmlFor="model-select">{t.settings.modelName}</label>
                <select
                  id="model-select"
                  value={currentConfig.model}
                  onChange={(e) => handleConfigChange('model', e.target.value)}
                  className="select-styled"
                  style={{ width: '100%' }}
                >
                  {(activeTab === 'gemini' && availableGeminiModels && availableGeminiModels.length > 0
                    ? availableGeminiModels
                    : activeTab === 'grok' && availableGrokModels && availableGrokModels.length > 0
                    ? availableGrokModels
                    : activeTab === 'ollama' && availableOllamaModels && availableOllamaModels.length > 0
                    ? availableOllamaModels
                    : (PROVIDER_MODELS[activeTab as LLMProvider] || [])
                  ).map(model => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>

              {/* API Key Input */}
              <div className="form-group">
                <label htmlFor="api-key-input" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <Key size={14} /> {activeTab === 'ollama' ? 'API Key (Optional)' : `${labels[activeTab]} ${t.settings.apiKey}`}
                </label>
                <input
                  id="api-key-input"
                  type="password"
                  value={currentConfig.apiKey}
                  onChange={(e) => handleConfigChange('apiKey', e.target.value)}
                  placeholder={
                    activeTab === 'gemini' ? 'Enter Google AI Studio API Key...' :
                    activeTab === 'openai' ? 'Enter OpenAI API Key (sk-...)...' :
                    activeTab === 'anthropic' ? 'Enter Anthropic API Key (sk-ant-...)...' :
                    activeTab === 'grok' ? 'Enter Grok API Key (xai-...)...' :
                    'Optional token for authenticated local proxies...'
                  }
                  className="form-input"
                />
              </div>

              {/* Base URL Input */}
              <div className="form-group">
                <label htmlFor="base-url-input">{t.settings.baseUrl}</label>
                <input
                  id="base-url-input"
                  type="text"
                  value={currentConfig.baseUrl}
                  onChange={(e) => handleConfigChange('baseUrl', e.target.value)}
                  placeholder={
                    activeTab === 'gemini' ? 'e.g. https://generativelanguage.googleapis.com/v1beta' :
                    activeTab === 'openai' ? 'e.g. https://api.openai.com/v1' :
                    activeTab === 'anthropic' ? 'e.g. https://api.anthropic.com/v1' :
                    activeTab === 'grok' ? 'e.g. https://api.x.ai/v1' :
                    'e.g. http://localhost:11434/v1'
                  }
                  className="form-input"
                />
              </div>

              {/* Summary Utility Model Input */}
              <div className="form-group">
                <label htmlFor="summary-provider-select">{t.settings.summaryProvider}</label>
                <select
                  id="summary-provider-select"
                  value={summaryProvider}
                  onChange={(e) => setSummaryProvider(e.target.value as LLMProvider | 'active')}
                  className="form-input"
                  style={{ marginBottom: '0.75rem' }}
                >
                  <option value="active">{t.settings.summaryProviderFollowChat}</option>
                  {(Object.keys(labels) as LLMProvider[]).map(p => (
                    <option key={p} value={p}>{labels[p]}</option>
                  ))}
                </select>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '-0.5rem 0 0.75rem' }}>
                  {t.settings.summaryProviderHint}
                </p>

                <label htmlFor="summary-model-input">Summary Model (optional — cheap model for background chapter summaries; empty = chat model)</label>
                <input
                  id="summary-model-input"
                  type="text"
                  value={currentConfig.summaryModel || ''}
                  onChange={(e) => handleConfigChange('summaryModel', e.target.value)}
                  placeholder={
                    activeTab === 'gemini' ? 'e.g. gemini-2.5-flash' :
                    activeTab === 'openai' ? 'e.g. gpt-4o-mini' :
                    activeTab === 'anthropic' ? 'e.g. claude-haiku-4-5-20251001' :
                    activeTab === 'grok' ? 'e.g. grok-3' :
                    'e.g. llama3'
                  }
                  className="form-input"
                />
              </div>

              {/* Max Output Tokens Input */}
              <div className="form-group">
                <label htmlFor="max-tokens-input">Max Output Tokens (up to 65536)</label>
                <input
                  id="max-tokens-input"
                  type="number"
                  value={currentConfig.maxOutputTokens || 16384}
                  onChange={(e) => handleConfigChange('maxOutputTokens', parseInt(e.target.value) || 16384)}
                  placeholder="e.g. 16384"
                  min={1024}
                  max={65536}
                  step={1024}
                  className="form-input"
                />
              </div>

              {/* Reasoning effort — only for models that actually take one. */}
              {supportsReasoningEffort(activeTab, currentConfig.model) && (
                <div className="form-group">
                  <label htmlFor="reasoning-effort-select">{t.settings.reasoningEffort}</label>
                  <select
                    id="reasoning-effort-select"
                    value={currentConfig.reasoningEffort ?? DEFAULT_REASONING_EFFORT}
                    onChange={(e) => handleConfigChange('reasoningEffort', e.target.value)}
                    className="form-input"
                  >
                    {supportedReasoningEfforts(activeTab, currentConfig.model).map(level => (
                      <option key={level} value={level}>
                        {level === 'default' ? t.settings.reasoningProviderDefault : level}
                      </option>
                    ))}
                  </select>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>
                    {t.settings.reasoningEffortHint}
                  </p>
                </div>
              )}

              {/* How this model is asked to edit the document. Per provider,
                  because the right answer depends on how the provider streams
                  tool arguments — see utils/protocolChoice. */}
              <div className="form-group">
                <label htmlFor="document-protocol-select">{t.settings.documentProtocol}</label>
                <select
                  id="document-protocol-select"
                  value={currentConfig.documentProtocol ?? 'auto'}
                  onChange={(e) => handleConfigChange('documentProtocol', e.target.value)}
                  className="form-input"
                >
                  <option value="auto">
                    {t.settings.protocolAuto(
                      autoProtocolFor(activeTab) === 'tools' ? t.settings.protocolTools : t.settings.protocolMarkup
                    )}
                  </option>
                  <option value="tools">{t.settings.protocolTools}</option>
                  <option value="markup">{t.settings.protocolMarkup}</option>
                </select>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>
                  {t.settings.documentProtocolHint}
                </p>
              </div>

              {/* Debug Mode Checkbox */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                <input 
                  id="debug-mode-checkbox"
                  type="checkbox"
                  checked={debugMode}
                  onChange={(e) => setDebugMode(e.target.checked)}
                  style={{
                    width: '16px',
                    height: '16px',
                    accentColor: 'var(--accent)',
                    cursor: 'pointer'
                  }}
                />
                <label 
                  htmlFor="debug-mode-checkbox"
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    userSelect: 'none'
                  }}
                >
                  Enable Debug Mode (logs request/response in console)
                </label>
              </div>


              {/* Help Info Box */}
              <div 
                className="form-help" 
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  padding: '0.75rem',
                  borderRadius: '8px',
                  backgroundColor: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                }}
              >
                <HelpCircle size={16} style={{ flexShrink: 0, color: 'var(--text-secondary)', marginTop: '2px' }} />
                <span style={{ fontSize: '0.85rem', lineHeight: '1.4' }}>
                  {activeTab === 'gemini' && (
                    <>
                      To get a free Gemini API key, visit the{' '}
                      <a 
                        href="https://aistudio.google.com/" 
                        target="_blank" 
                        rel="noreferrer"
                        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                      >
                        Google AI Studio
                      </a>
                      . The default base URL is <code>https://generativelanguage.googleapis.com/v1beta</code>.
                    </>
                  )}
                  {activeTab === 'openai' && (
                    <>
                      To get an OpenAI API key, visit the{' '}
                      <a 
                        href="https://platform.openai.com/" 
                        target="_blank" 
                        rel="noreferrer"
                        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                      >
                        OpenAI Platform
                      </a>
                      . The default base URL is <code>https://api.openai.com/v1</code>.
                    </>
                  )}
                  {activeTab === 'anthropic' && (
                    <>
                      To get an Anthropic API key, visit the{' '}
                      <a 
                        href="https://console.anthropic.com/" 
                        target="_blank" 
                        rel="noreferrer"
                        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                      >
                        Anthropic Console
                      </a>
                      . The default base URL is <code>https://api.anthropic.com/v1</code>.
                    </>
                  )}
                  {activeTab === 'ollama' && (
                    <>
                      Ollama runs locally on your machine. Ensure Ollama is running (run <code>ollama serve</code>) and the base URL is reachable. The default is <code>http://localhost:11434/v1</code>.
                    </>
                  )}
                  {activeTab === 'grok' && (
                    <>
                      To get a Grok API key, visit the{' '}
                      <a 
                        href="https://console.x.ai/" 
                        target="_blank" 
                        rel="noreferrer"
                        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                      >
                        xAI Console
                      </a>
                      . The default base URL is <code>https://api.x.ai/v1</code>.
                    </>
                  )}
                </span>
              </div>

              {/* Gemini Safety Settings Section */}
              {activeTab === 'gemini' && (
                <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem' }}>
                    <ShieldAlert size={16} style={{ color: 'var(--accent)' }} />
                    <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Gemini Safety Thresholds</span>
                  </div>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                    {(() => {
                      const safetyCategories = [
                        { id: 'HARM_CATEGORY_HARASSMENT', label: 'Harassment' },
                        { id: 'HARM_CATEGORY_HATE_SPEECH', label: 'Hate Speech' },
                        { id: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', label: 'Sexually Explicit' },
                        { id: 'HARM_CATEGORY_DANGEROUS_CONTENT', label: 'Dangerous Content' },
                      ]
                      
                      const thresholds = [
                        { value: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED', label: 'Default / Unspecified' },
                        { value: 'BLOCK_NONE', label: 'Block None (Show All)' },
                        { value: 'BLOCK_ONLY_HIGH', label: 'Block High Risk' },
                        { value: 'BLOCK_MEDIUM_AND_ABOVE', label: 'Block Medium & Above' },
                        { value: 'BLOCK_LOW_AND_ABOVE', label: 'Block Low & Above' },
                      ]
                      
                      const currentSettings = geminiConfig.geminiSafetySettings || []
                      
                      return safetyCategories.map(cat => {
                        const currentSetting = currentSettings.find(s => s.category === cat.id)
                        const currentValue = currentSetting?.threshold || 'BLOCK_MEDIUM_AND_ABOVE'
                        
                        return (
                          <div key={cat.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                              {cat.label}
                            </span>
                            <select
                              value={currentValue}
                              onChange={(e) => {
                                const updated = currentSettings.map(s => 
                                  s.category === cat.id ? { ...s, threshold: e.target.value } : s
                                )
                                // In case the list was empty or missing this category
                                if (!currentSettings.some(s => s.category === cat.id)) {
                                  updated.push({ category: cat.id, threshold: e.target.value })
                                }
                                updateProviderConfig('gemini', { geminiSafetySettings: updated })
                              }}
                              className="select-styled"
                              style={{ width: '100%', fontSize: '0.8rem', padding: '0.35rem 0.5rem' }}
                            >
                              {thresholds.map(t => (
                                <option key={t.value} value={t.value}>
                                  {t.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        )
                      })
                    })()}
                  </div>
                </div>
              )}

              {/* Active System Prompt Selector */}
              <div className="form-group" style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                <label htmlFor="active-prompt-select" style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.35rem' }}>
                  Active Prompt Preset
                </label>
                <select
                  id="active-prompt-select"
                  value={activeSystemPromptId}
                  onChange={(e) => setActiveSystemPromptId(e.target.value)}
                  className="select-styled"
                  style={{ width: '100%' }}
                >
                  {customSystemPrompts.map(prompt => (
                    <option key={prompt.id} value={prompt.id}>
                      {prompt.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Presets Management Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Edit size={16} style={{ color: 'var(--accent)' }} />
                  <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-secondary)' }}>System Prompt Presets</span>
                </div>
                <button 
                  onClick={() => addSystemPrompt('New Preset', '')}
                  className="btn-icon" 
                  title="Add New Preset"
                  type="button"
                  style={{ padding: '4px', borderRadius: '4px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--accent)' }}
                >
                  <Plus size={16} />
                </button>
              </div>

              {/* Presets Management List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {customSystemPrompts.map((prompt) => (
                  <div 
                    key={prompt.id} 
                    style={{
                      padding: '0.75rem',
                      borderRadius: '8px',
                      backgroundColor: 'var(--bg-tertiary)',
                      border: '1px solid var(--border-color)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input
                        type="text"
                        value={prompt.name}
                        onChange={(e) => updateSystemPrompt(prompt.id, { name: e.target.value })}
                        placeholder="Preset Name..."
                        className="form-input"
                        style={{ flex: 1, fontWeight: 600, padding: '0.35rem 0.6rem', fontSize: '0.85rem' }}
                      />
                      
                      <button 
                        onClick={() => deleteSystemPrompt(prompt.id)}
                        className="btn-icon" 
                        title="Delete Preset"
                        type="button"
                        disabled={customSystemPrompts.length <= 1}
                        style={{ 
                          color: customSystemPrompts.length <= 1 ? 'var(--text-muted)' : 'var(--text-secondary)',
                          cursor: customSystemPrompts.length <= 1 ? 'default' : 'pointer'
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    
                    <textarea
                      value={prompt.content}
                      onChange={(e) => updateSystemPrompt(prompt.id, { content: e.target.value })}
                      placeholder="System instruction contents..."
                      className="form-input"
                      rows={3}
                      style={{ resize: 'vertical', width: '100%', fontSize: '0.85rem', padding: '0.4rem 0.6rem', fontFamily: 'inherit' }}
                    />
                  </div>
                ))}
              </div>

              {/* Image Analysis Prompt Section */}
              <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <Image size={16} style={{ color: 'var(--accent)' }} />
                    <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Image Analysis Prompt</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setImageAnalysisPrompt(DEFAULT_IMAGE_ANALYSIS_PROMPT)}
                    className="btn-icon"
                    title="Reset to default prompt"
                    style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '4px 8px', borderRadius: '4px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', fontSize: '0.75rem' }}
                  >
                    <RotateCcw size={12} />
                    Reset
                  </button>
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.5rem', lineHeight: 1.4 }}>
                  System prompt sent to the LLM when analyzing images during URL import. Use <code style={{ backgroundColor: 'var(--bg-tertiary)', padding: '0 3px', borderRadius: '3px' }}>{'{{index}}'}</code> as a placeholder for the image number.
                </p>
                <textarea
                  id="image-analysis-prompt-input"
                  value={imageAnalysisPrompt}
                  onChange={(e) => setImageAnalysisPrompt(e.target.value)}
                  className="form-input"
                  rows={10}
                  style={{ resize: 'vertical', width: '100%', fontSize: '0.82rem', padding: '0.5rem 0.6rem', fontFamily: 'monospace', lineHeight: 1.5 }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {imageAnalysisPrompt.length} chars
                  </span>
                </div>
              </div>
            </>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }} type="button">
            <Save size={16} /> {t.settings.save}
          </button>
        </div>
      </div>
    </div>
  )
}
