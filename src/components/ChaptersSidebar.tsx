import React from 'react'
import { Plus, Trash2, BookOpen, ChevronLeft } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'

export const ChaptersSidebar: React.FC = () => {
  const {
    documents,
    activeDocumentId,
    isSidebarOpen,
    setActiveDocumentId,
    addDocument,
    deleteDocument,
    toggleSidebar
  } = useAppStore()

  if (!isSidebarOpen) return null

  const handleAddDoc = () => {
    const chapterNum = documents.length + 1
    addDocument(`Chapter ${chapterNum}: Untitled`)
  }

  return (
    <aside className={`chapters-sidebar ${isSidebarOpen ? '' : 'collapsed'}`}>
      <div className="sidebar-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <BookOpen size={16} style={{ color: 'var(--text-secondary)' }} />
          <h2>Chapters</h2>
        </div>
        <button 
          onClick={toggleSidebar} 
          className="btn-icon" 
          title="Collapse Sidebar"
          type="button"
          style={{ padding: '0.25rem' }}
        >
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="chapters-list">
        {documents.map((doc) => {
          const isActive = doc.id === activeDocumentId
          
          return (
            <div
              key={doc.id}
              onClick={() => setActiveDocumentId(doc.id)}
              className={`chapter-item ${isActive ? 'active' : ''}`}
              title={doc.title}
            >
              <span className="chapter-title">{doc.title || 'Untitled Chapter'}</span>
              
              <button
                onClick={(e) => {
                  e.stopPropagation() // Prevent selecting the doc on delete
                  if (confirm(`Are you sure you want to delete "${doc.title}"?`)) {
                    deleteDocument(doc.id)
                  }
                }}
                className="btn-icon chapter-delete-btn"
                title="Delete chapter"
                type="button"
                style={{ padding: '0.15rem' }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </div>

      <div style={{ padding: '1rem', borderTop: '1px solid var(--border-color)' }}>
        <button
          onClick={handleAddDoc}
          className="btn-primary"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            fontSize: '0.85rem',
            padding: '0.6rem'
          }}
          type="button"
        >
          <Plus size={16} /> New Chapter
        </button>
      </div>
    </aside>
  )
}
