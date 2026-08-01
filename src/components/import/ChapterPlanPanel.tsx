/**
 * Chapter plan preview block of the import modal: book title, summary, and
 * per-chapter generation progress markers. Presentational only.
 */

import React from 'react'
import type { ChapterPlan, GeneratedChapter } from '../../types/import'

interface ChapterPlanPanelProps {
  chapterPlan: ChapterPlan
  generatedChapters: GeneratedChapter[]
}

export const ChapterPlanPanel: React.FC<ChapterPlanPanelProps> = ({
  chapterPlan,
  generatedChapters,
}) => {
  return (
    <div style={{
      padding: '0.75rem',
      backgroundColor: 'var(--bg-primary)',
      borderRadius: '8px',
      border: '1px solid var(--border-color)'
    }}>
      <div style={{
        fontSize: '0.85rem',
        fontWeight: 600,
        marginBottom: '0.5rem',
        color: 'var(--accent)'
      }}>
        📋 章节规划: {chapterPlan.bookTitle}
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
        {chapterPlan.summary}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {chapterPlan.chapters.map((ch, idx) => (
          <div key={idx} style={{
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
            padding: '0.25rem 0',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <span style={{ color: 'var(--accent)', fontWeight: 500 }}>
              {generatedChapters.find(g => g.chapterNumber === ch.chapterNumber) ? '✅' : '📖'}
            </span>
            <span>{ch.title}</span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              ({ch.mood})
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
