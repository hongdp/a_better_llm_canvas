import React from 'react'
import { X, Key, Shield, HelpCircle, Save, Plus, Trash2, Edit, AlertCircle, ShieldAlert, Database, UploadCloud, DownloadCloud, CheckCircle2, RefreshCw, AlertTriangle } from 'lucide-react'
import { useAppStore, type LLMProvider } from '../store/useAppStore'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  errorMsg?: string | null
  setErrorMsg?: (msg: string | null) => void
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, errorMsg, setErrorMsg }) => {
  const { 
    activeProvider,
    providerConfigs, 
    updateProviderConfig,
    customSystemPrompts,
    addSystemPrompt,
    updateSystemPrompt,
    deleteSystemPrompt,
    debugMode,
    setDebugMode,
    storageMode,
    setStorageMode,
    syncStatus,
    checkSyncStatus,
    uploadToServer,
    downloadFromServer
  } = useAppStore()

  const [activeTab, setActiveTab] = React.useState<LLMProvider | 'storage'>('gemini')

  // Set the default tab to the active provider when the modal opens
  React.useEffect(() => {
    if (isOpen) {
      setActiveTab(activeProvider)
    }
  }, [isOpen, activeProvider])

  if (!isOpen) return null

  const currentConfig = (activeTab !== 'storage' ? providerConfigs[activeTab] : null) || providerConfigs.gemini
  const geminiConfig = providerConfigs.gemini

  const handleConfigChange = (field: 'apiKey' | 'baseUrl' | 'maxOutputTokens', value: string | number) => {
    if (activeTab !== 'storage') {
      updateProviderConfig(activeTab, { [field]: value })
    }
  }

  const labels: Record<LLMProvider | 'storage', string> = {
    gemini: 'Gemini',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    ollama: 'Ollama (Local)',
    grok: 'Grok (xAI)',
    storage: 'Storage & Sync'
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
            {activeTab === 'storage' ? (
              <Database size={18} style={{ color: 'var(--accent)' }} />
            ) : (
              <Shield size={18} style={{ color: 'var(--accent)' }} />
            )}
            <h3>{activeTab === 'storage' ? 'Storage & Sync' : `${labels[activeTab]} Configuration`}</h3>
          </div>
          <button onClick={onClose} className="btn-icon" title="Close" type="button">
            <X size={18} />
          </button>
        </div>

        {/* Selection Tabs */}
        <div className="settings-tabs" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {(['gemini', 'openai', 'anthropic', 'ollama', 'grok', 'storage'] as const).map((prov) => (
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

          {activeTab === 'storage' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Storage Mode Selection */}
              <div className="form-group">
                <label style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.5rem' }}>
                  Storage Location
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {/* Server storage option */}
                  <label style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    padding: '0.85rem',
                    borderRadius: '8px',
                    backgroundColor: storageMode === 'server' ? 'rgba(var(--accent-rgb), 0.08)' : 'var(--bg-tertiary)',
                    border: storageMode === 'server' ? '1px solid var(--accent)' : '1px solid var(--border-color)',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}>
                    <input
                      type="radio"
                      name="storage-mode"
                      checked={storageMode === 'server'}
                      onChange={() => setStorageMode('server')}
                      style={{ marginTop: '3px', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                        Server-Side Storage (Recommended)
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                        Automatically saves all documents, versions, and chats to the server's workspace folder. Enables multi-device access and cross-session persistence.
                      </span>
                    </div>
                  </label>

                  {/* Client storage option */}
                  <label style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    padding: '0.85rem',
                    borderRadius: '8px',
                    backgroundColor: storageMode === 'client' ? 'rgba(var(--accent-rgb), 0.08)' : 'var(--bg-tertiary)',
                    border: storageMode === 'client' ? '1px solid var(--accent)' : '1px solid var(--border-color)',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}>
                    <input
                      type="radio"
                      name="storage-mode"
                      checked={storageMode === 'client'}
                      onChange={() => setStorageMode('client')}
                      style={{ marginTop: '3px', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                        Browser Local Storage Only
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                        Saves documents exclusively inside your browser's local cache (`localStorage`). Safe for offline usage, but changes won't be saved to the server.
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Live Sync Status Panel */}
              {storageMode === 'server' && (
                <div style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: '10px',
                  padding: '1rem',
                  backgroundColor: 'var(--bg-tertiary)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      Synchronization Status
                    </span>
                    <button
                      onClick={() => checkSyncStatus()}
                      type="button"
                      className="btn-icon"
                      title="Check Connection and Diff"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--accent)', padding: '2px 8px', borderRadius: '4px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
                    >
                      <RefreshCw size={12} className={syncStatus === 'checking' ? 'animate-spin' : ''} /> Check Status
                    </button>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0' }}>
                    {syncStatus === 'checking' && (
                      <>
                        <RefreshCw size={16} className="animate-spin" style={{ color: 'var(--accent)' }} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Checking status...</span>
                      </>
                    )}
                    {syncStatus === 'in-sync' && (
                      <>
                        <CheckCircle2 size={16} style={{ color: '#10b981' }} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#10b981' }}>In Sync with Server</span>
                      </>
                    )}
                    {syncStatus === 'mismatch' && (
                      <>
                        <AlertTriangle size={16} style={{ color: '#f59e0b' }} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f59e0b' }}>Out of Sync (Content Mismatch)</span>
                      </>
                    )}
                    {(syncStatus === 'unknown' || syncStatus === 'client-mode') && (
                      <>
                        <AlertCircle size={16} style={{ color: 'var(--text-muted)' }} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Status Unknown or Offline</span>
                      </>
                    )}
                  </div>
                  
                  {syncStatus === 'mismatch' && (
                    <span style={{ fontSize: '0.75rem', color: '#f59e0b', lineHeight: 1.4 }}>
                      Your browser's local contents differ from the server workspace files. Please perform a manual Sync below to reconcile differences.
                    </span>
                  )}
                </div>
              )}

              {/* Manual Synchronization Controls */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Manual Reconcile & Sync
                </span>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
                  Use these controls to force synchronization in either direction. Be careful: both actions will overwrite targeted data.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.25rem' }}>
                  {/* Upload */}
                  <button
                    onClick={async () => {
                      if (window.confirm('Are you sure you want to UPLOAD local browser data? This will overwrite the server storage.')) {
                        try {
                          await uploadToServer()
                          alert('Successfully uploaded local storage to server!')
                        } catch (e) {
                          alert('Failed to upload data.')
                        }
                      }
                    }}
                    type="button"
                    className="btn-primary"
                    style={{
                      padding: '0.5rem',
                      justifyContent: 'center',
                      fontSize: '0.8rem',
                      backgroundColor: 'rgba(var(--accent-rgb), 0.12)',
                      color: 'var(--accent)',
                      border: '1px solid var(--accent)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      borderRadius: '6px'
                    }}
                  >
                    <UploadCloud size={14} /> Upload to Server
                  </button>

                  {/* Download */}
                  <button
                    onClick={async () => {
                      if (window.confirm('Are you sure you want to DOWNLOAD server data? This will overwrite all your current browser content.')) {
                        try {
                          await downloadFromServer()
                          alert('Successfully downloaded server storage to local browser!')
                        } catch (e) {
                          alert('Failed to download data.')
                        }
                      }
                    }}
                    type="button"
                    className="btn-primary"
                    style={{
                      padding: '0.5rem',
                      justifyContent: 'center',
                      fontSize: '0.8rem',
                      backgroundColor: '#10b981',
                      color: '#ffffff',
                      border: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      borderRadius: '6px'
                    }}
                  >
                    <DownloadCloud size={14} /> Download from Server
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* API Key Input */}
              <div className="form-group">
                <label htmlFor="api-key-input" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <Key size={14} /> {activeTab === 'ollama' ? 'API Key (Optional)' : `${labels[activeTab]} API Key`}
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
                <label htmlFor="base-url-input">API Base URL</label>
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
            </>
          )}
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
