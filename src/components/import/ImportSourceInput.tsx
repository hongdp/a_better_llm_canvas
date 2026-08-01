/**
 * URL input + local HTML file upload block of the import modal.
 * Presentational only; fetch/upload handlers live in ImportUrlModal.
 */

import React from 'react'
import { FileText } from 'lucide-react'
import type { ImportStatus } from './types'

interface ImportSourceInputProps {
  url: string
  onUrlChange: (value: string) => void
  status: ImportStatus
  onFetch: () => void
  onLocalFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  localFileInputRef: React.RefObject<HTMLInputElement | null>
}

export const ImportSourceInput: React.FC<ImportSourceInputProps> = ({
  url,
  onUrlChange,
  status,
  onFetch,
  onLocalFileChange,
  localFileInputRef,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="url"
          placeholder="粘贴网页URL..."
          value={url}
          onChange={e => onUrlChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (status === 'idle' || status === 'error')) onFetch()
          }}
          disabled={status !== 'idle' && status !== 'error'}
          className="form-input"
          style={{
            flex: 1,
            padding: '0.6rem 0.8rem',
            fontSize: '0.9rem',
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            color: 'var(--text-primary)',
            outline: 'none'
          }}
        />
        {(status === 'idle' || status === 'error') && (
          <button
            onClick={onFetch}
            disabled={!url.trim()}
            className="btn-primary"
            type="button"
            style={{
              padding: '0.6rem 1rem',
              fontSize: '0.85rem',
              whiteSpace: 'nowrap',
              opacity: url.trim() ? 1 : 0.5
            }}
          >
            抓取网页
          </button>
        )}
      </div>

      {(status === 'idle' || status === 'error') && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            padding: '1rem',
            border: '1px dashed var(--border-color)',
            borderRadius: '8px',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
            cursor: 'pointer',
            transition: 'border-color 0.2s',
          }}
          onClick={() => localFileInputRef.current?.click()}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
        >
          <FileText size={18} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            或者：上传本地网页文件 (.html, .htm) 进行解析与创作
          </span>
          <input
            type="file"
            ref={localFileInputRef}
            onChange={onLocalFileChange}
            accept=".html,.htm"
            style={{ display: 'none' }}
          />
        </div>
      )}
    </div>
  )
}
