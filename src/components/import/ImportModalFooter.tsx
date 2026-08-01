/**
 * Footer button row of the import modal — the visible buttons depend on the
 * current pipeline status. Presentational only; the handlers live in
 * ImportUrlModal.
 */

import React from 'react'
import { Sparkles } from 'lucide-react'
import type { ImportStatus } from './types'

interface ImportModalFooterProps {
  status: ImportStatus
  hasGeneratedChapters: boolean
  onReset: () => void
  onStartGeneration: () => void
  onCancelGeneration: () => void
  onClose: () => void
  onSaveAndExit: () => void
  onManualRetry: () => void
}

export const ImportModalFooter: React.FC<ImportModalFooterProps> = ({
  status,
  hasGeneratedChapters,
  onReset,
  onStartGeneration,
  onCancelGeneration,
  onClose,
  onSaveAndExit,
  onManualRetry,
}) => {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '0.75rem',
      paddingTop: '1rem',
      borderTop: '1px solid var(--border-color)',
      marginTop: '1rem'
    }}>
      {status === 'preview' && (
        <>
          <button
            onClick={onReset}
            className="btn-secondary"
            type="button"
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            重新输入
          </button>
          <button
            onClick={onStartGeneration}
            className="btn-primary"
            type="button"
            style={{
              padding: '0.5rem 1.5rem',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}
          >
            <Sparkles size={14} />
            开始生成小说
          </button>
        </>
      )}

      {(status === 'analyzing' || status === 'generating') && (
        <button
          onClick={onCancelGeneration}
          className="btn-secondary"
          type="button"
          style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', color: '#ef4444' }}
        >
          取消生成
        </button>
      )}

      {status === 'done' && (
        <button
          onClick={onClose}
          className="btn-primary"
          type="button"
          style={{ padding: '0.5rem 1.5rem', fontSize: '0.85rem' }}
        >
          完成
        </button>
      )}

      {(status === 'idle' || status === 'error') && (
        <button
          onClick={onClose}
          className="btn-secondary"
          type="button"
          style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
        >
          取消
        </button>
      )}

      {status === 'prompt_edit' && (
        <>
          {hasGeneratedChapters && (
            <button
              onClick={onSaveAndExit}
              className="btn-secondary"
              type="button"
              style={{ padding: '0.5rem 1rem', fontSize: '0.85rem', color: '#10b981', borderColor: '#10b981' }}
            >
              保留已生成并退出
            </button>
          )}
          <button
            onClick={onClose}
            className="btn-secondary"
            type="button"
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            取消
          </button>
          <button
            onClick={onManualRetry}
            className="btn-primary"
            type="button"
            style={{
              padding: '0.5rem 1.5rem',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}
          >
            <Sparkles size={14} />
            手动重试
          </button>
        </>
      )}
    </div>
  )
}
