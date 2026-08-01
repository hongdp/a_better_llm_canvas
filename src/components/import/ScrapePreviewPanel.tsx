/**
 * Scraped-content preview block of the import modal: title, counts, text
 * excerpt, and the image selection list (with live analysis descriptions).
 * Presentational only; scraping/analysis state lives in ImportUrlModal.
 */

import React from 'react'
import { FileText } from 'lucide-react'
import type { ScrapedData } from '../../types/import'
import type { ImportStatus } from './types'

interface ScrapePreviewPanelProps {
  scrapedData: ScrapedData
  status: ImportStatus
  selectedImageIndices: number[]
  setSelectedImageIndices: React.Dispatch<React.SetStateAction<number[]>>
  analyzedIndices: number[]
}

export const ScrapePreviewPanel: React.FC<ScrapePreviewPanelProps> = ({
  scrapedData,
  status,
  selectedImageIndices,
  setSelectedImageIndices,
  analyzedIndices,
}) => {
  const previewText = scrapedData.paragraphs.slice(0, 5).map(p => p.text).join('\n').substring(0, 500)

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '0.75rem',
      padding: '1rem',
      backgroundColor: 'var(--bg-primary)',
      borderRadius: '8px',
      border: '1px solid var(--border-color)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <FileText size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{scrapedData.title}</span>
      </div>

      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', gap: '1rem' }}>
        <span>📄 {scrapedData.totalParagraphs} 段文字</span>
        <span>🖼️ {scrapedData.totalImages} 张配图</span>
      </div>

      {/* Text preview */}
      <div style={{
        fontSize: '0.8rem',
        color: 'var(--text-secondary)',
        lineHeight: 1.5,
        maxHeight: '100px',
        overflowY: 'auto',
        padding: '0.5rem',
        backgroundColor: 'var(--bg-tertiary)',
        borderRadius: '6px',
        whiteSpace: 'pre-wrap'
      }}>
        {previewText}{previewText.length >= 500 ? '...' : ''}
      </div>

      {/* Image thumbnails with descriptions */}
      {scrapedData.images.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          maxHeight: '150px',
          overflowY: 'auto',
          padding: '0.5rem',
          backgroundColor: 'var(--bg-tertiary)',
          borderRadius: '6px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>
              📷 选择保留的配图 (将在生成中被AI使用):
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setSelectedImageIndices(scrapedData.images.map(img => img.index))}
                style={{ fontSize: '0.7rem', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >全选</button>
              <button
                onClick={() => setSelectedImageIndices([])}
                style={{ fontSize: '0.7rem', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >全不选</button>
            </div>
          </div>
          {(() => {
            const sortedImages = [
              ...analyzedIndices
                .map(idx => scrapedData.images.find(img => img.index === idx))
                .filter((img): img is NonNullable<typeof img> => !!img),
              ...scrapedData.images.filter(img => !analyzedIndices.includes(img.index))
            ]
            return sortedImages.map((img, idx) => (
              <div key={idx} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                fontSize: '0.75rem',
                opacity: selectedImageIndices.includes(img.index) ? 1 : 0.5,
                padding: '4px 0'
              }}>
                <input
                  type="checkbox"
                  checked={selectedImageIndices.includes(img.index)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedImageIndices(prev => [...prev, img.index])
                    } else {
                      setSelectedImageIndices(prev => prev.filter(id => id !== img.index))
                    }
                  }}
                  disabled={status !== 'preview'}
                  style={{ cursor: status === 'preview' ? 'pointer' : 'default' }}
                />
                <img
                  src={img.base64}
                  alt={img.alt || `Image ${idx}`}
                  style={{
                    width: '72px',
                    height: '72px',
                    objectFit: 'cover',
                    borderRadius: '4px',
                    border: '1px solid var(--border-color)',
                    flexShrink: 0
                  }}
                />
                <span style={{ color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>
                  IMG-{img.index}
                </span>
                <span style={{
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}>
                  {img.alt || '（无文字描述）'}
                </span>
              </div>
            ))
          })()}
        </div>
      )}
    </div>
  )
}
