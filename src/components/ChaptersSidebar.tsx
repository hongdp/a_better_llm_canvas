import React, { useRef, useState } from 'react'
import { Plus, Trash2, BookOpen, ChevronLeft, Upload, ShieldAlert } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { markdownToHtml, txtToHtml, sanitizeHtml, splitHtmlToChapters, splitMarkdownToChapters, splitTxtToChapters } from '../utils/convert'

export const ChaptersSidebar: React.FC = () => {
  const {
    documents,
    activeDocumentId,
    isSidebarOpen,
    setActiveDocumentId,
    addDocument,
    importAllDocuments,
    deleteDocument,
    toggleSidebar
  } = useAppStore()

  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false)
  const [pendingChapters, setPendingChapters] = useState<{ title: string; content: string }[]>([])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const replaceFileInputRef = useRef<HTMLInputElement>(null)

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

  const handleReplaceClick = () => {
    replaceFileInputRef.current?.click()
  }

  const handleReplaceFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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

      let parsedChapters: { title: string; content: string }[] = []
      const extension = file.name.split('.').pop()?.toLowerCase() || ''
      const filenameWithoutExt = file.name.substring(0, file.name.lastIndexOf('.')) || file.name

      if (['md', 'markdown'].includes(extension)) {
        parsedChapters = splitMarkdownToChapters(text)
      } else if (['html', 'htm'].includes(extension)) {
        parsedChapters = splitHtmlToChapters(text)
      } else {
        parsedChapters = splitTxtToChapters(text)
      }

      // Fallback: if splitting resulted in 0 chapters, treat whole file as a single chapter
      if (parsedChapters.length === 0) {
        let htmlContent = ''
        if (['md', 'markdown'].includes(extension)) {
          htmlContent = markdownToHtml(text)
        } else if (['html', 'htm'].includes(extension)) {
          htmlContent = sanitizeHtml(text)
        } else {
          htmlContent = txtToHtml(text)
        }
        parsedChapters = [{ title: filenameWithoutExt, content: htmlContent }]
      }

      // Map empty titles to the filename
      parsedChapters = parsedChapters.map((ch, idx) => ({
        title: ch.title.trim() || `${filenameWithoutExt} - Part ${idx + 1}`,
        content: ch.content
      }))

      setPendingChapters(parsedChapters)
      setShowReplaceConfirm(true)

      // Reset the file input
      if (replaceFileInputRef.current) {
        replaceFileInputRef.current.value = ''
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
        <button
          onClick={handleReplaceClick}
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
          <Upload size={16} /> Replace All Chapters
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".html,.htm,.md,.markdown,.txt"
          style={{ display: 'none' }}
        />
        <input
          type="file"
          ref={replaceFileInputRef}
          onChange={handleReplaceFileChange}
          accept=".html,.htm,.md,.markdown,.txt"
          style={{ display: 'none' }}
        />
      </div>

      {showReplaceConfirm && (
        <div className="modal-overlay" onClick={() => setShowReplaceConfirm(false)}>
          <div 
            className="modal-content glass-panel" 
            onClick={(e) => e.stopPropagation()}
            style={{
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              maxWidth: '420px',
              padding: '1.5rem',
              textAlign: 'left'
            }}
          >
            <div className="modal-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <ShieldAlert size={20} style={{ color: 'var(--accent)' }} />
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Replace All Chapters?</h3>
            </div>
            <div className="modal-body" style={{ margin: '1rem 0', fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              <p>This action will permanently delete all existing chapters in this project and replace them with the <strong>{pendingChapters.length}</strong> imported chapter(s).</p>
              <p style={{ marginTop: '0.5rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>Please make sure you have saved or exported a backup if you need to retain current data.</p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-color)' }}>
              <button 
                onClick={() => setShowReplaceConfirm(false)} 
                className="btn-secondary"
                style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}
                type="button"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  importAllDocuments(pendingChapters)
                  setShowReplaceConfirm(false)
                  setPendingChapters([])
                }} 
                className="btn-primary"
                style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}
                type="button"
              >
                Confirm Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
