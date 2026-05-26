import React from 'react'
import { X, Key, Shield, HelpCircle, Save, Plus, Trash2, Edit, AlertCircle, ShieldAlert } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  errorMsg?: string | null
  setErrorMsg?: (msg: string | null) => void
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, errorMsg, setErrorMsg }) => {
  const { 
    providerConfigs, 
    updateProviderConfig,
    customSystemPrompts,
    addSystemPrompt,
    updateSystemPrompt,
    deleteSystemPrompt,
    debugMode,
    setDebugMode
  } = useAppStore()

  if (!isOpen) return null

  const geminiConfig = providerConfigs.gemini

  const handleConfigChange = (field: 'apiKey' | 'baseUrl' | 'maxOutputTokens', value: string | number) => {
    updateProviderConfig('gemini', { [field]: value })
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
            <h3>Gemini Provider Settings</h3>
          </div>
          <button onClick={onClose} className="btn-icon" title="Close" type="button">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ maxHeight: '55vh', overflowY: 'auto', paddingRight: '0.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
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
                onClick={() => setErrorMsg?.(null)} 
                className="btn-icon" 
                title="Dismiss error"
                type="button"
                style={{ padding: '2px', color: '#f87171' }}
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* API Key Input */}
          <div className="form-group">
            <label htmlFor="api-key-input" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <Key size={14} /> Gemini API Key
            </label>
            <input
              id="api-key-input"
              type="password"
              value={geminiConfig.apiKey}
              onChange={(e) => handleConfigChange('apiKey', e.target.value)}
              placeholder="Enter Google AI Studio API Key..."
              className="form-input"
            />
          </div>

          {/* Base URL Input */}
          <div className="form-group">
            <label htmlFor="base-url-input">API Base URL</label>
            <input
              id="base-url-input"
              type="text"
              value={geminiConfig.baseUrl}
              onChange={(e) => handleConfigChange('baseUrl', e.target.value)}
              placeholder="e.g. https://generativelanguage.googleapis.com/v1beta"
              className="form-input"
            />
          </div>

          {/* Max Output Tokens Input */}
          <div className="form-group">
            <label htmlFor="max-tokens-input">Max Output Tokens (up to 65536)</label>
            <input
              id="max-tokens-input"
              type="number"
              value={geminiConfig.maxOutputTokens || 16384}
              onChange={(e) => handleConfigChange('maxOutputTokens', parseInt(e.target.value) || 16384)}
              placeholder="e.g. 16384"
              min={1024}
              max={65536}
              step={1024}
              className="form-input"
            />
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
            <span>
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
            </span>
          </div>

          {/* Gemini Safety Settings Section */}
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
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }} type="button">
            <Save size={16} /> Save & Close
          </button>
        </div>
      </div>
    </div>
  )
}
