import React, { useRef } from 'react'
import { Plus, Trash2, BookOpen, ChevronLeft, Upload } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { markdownToHtml, txtToHtml, sanitizeHtml } from '../utils/convert'

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

  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!isSidebarOpen) return null

  const handleAddDoc = () => {
    const chapterNum = documents.length + 1
    addDocument(`Chapter ${chapterNum}: Untitled`)
  }

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const file = files[0]
    
    // TODO(security): Validate file size bounds before parsing to prevent browser lockups on extremely large documents
    if (file.size > 10 * 1024 * 1024) { // 10MB limit
      alert('File is too large. Please select a file smaller than 10MB.')
      return
    }

    const reader = new FileReader()

    reader.onload = (event) => {
      const text = event.target?.result as string
      if (typeof text !== 'string') return

      let htmlContent = ''
      const extension = file.name.split('.').pop()?.toLowerCase() || ''
      const filenameWithoutExt = file.name.substring(0, file.name.lastIndexOf('.')) || file.name

      if (['md', 'markdown'].includes(extension)) {
        htmlContent = markdownToHtml(text)
      } else if (['html', 'htm'].includes(extension)) {
        htmlContent = sanitizeHtml(text)
      } else {
        // Plain text (txt or other)
        htmlContent = txtToHtml(text)
      }

      addDocument(filenameWithoutExt, htmlContent)

      // Reset the file input so the same file name can be imported consecutively if needed
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }

    reader.readAsText(file)
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

      <div style={{ padding: '1rem', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
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
        <button
          onClick={handleImportClick}
          className="btn-secondary"
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
          <Upload size={16} /> Import Chapter
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".html,.htm,.md,.markdown,.txt"
          style={{ display: 'none' }}
        />
      </div>
    </aside>
  )
}
