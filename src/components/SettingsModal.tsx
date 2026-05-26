import React from 'react'
import { X, Key, Shield, HelpCircle, Save } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { 
    providerConfigs, 
    updateProviderConfig 
  } = useAppStore()

  if (!isOpen) return null

  const geminiConfig = providerConfigs.gemini

  const handleConfigChange = (field: 'apiKey' | 'baseUrl', value: string) => {
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

        <div className="modal-body">
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
