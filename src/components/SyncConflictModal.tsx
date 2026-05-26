import React, { useState } from 'react'
import { AlertTriangle, Server, Laptop, RefreshCw } from 'lucide-react'

interface SyncConflictModalProps {
  conflict: {
    localState: any
    serverState: any
  }
  resolveConflict: (choice: 'local' | 'server') => Promise<void>
}

export const SyncConflictModal: React.FC<SyncConflictModalProps> = ({ conflict, resolveConflict }) => {
  const [resolving, setResolving] = useState<boolean>(false)

  const handleResolve = async (choice: 'local' | 'server') => {
    setResolving(true)
    try {
      await resolveConflict(choice)
    } catch (e) {
      console.error(e)
    } finally {
      setResolving(false)
    }
  }

  const localDocs = conflict.localState?.documents || []
  const serverDocs = conflict.serverState?.documents || []
  const localTitle = conflict.localState?.bookTitle || 'Untitled Book'
  const serverTitle = conflict.serverState?.bookTitle || 'Untitled Book'

  return (
    <div className="modal-overlay" style={{ zIndex: 1000 }}>
      <div 
        className="modal-content glass-panel" 
        style={{
          maxWidth: '800px',
          width: '95%',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
          border: '1px solid var(--border-color)',
          backgroundColor: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)',
          borderRadius: '16px',
          padding: '2.5rem'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '0.75rem' }}>
          <div style={{ 
            width: '56px', 
            height: '56px', 
            borderRadius: '50%', 
            backgroundColor: 'rgba(245, 158, 11, 0.15)', 
            border: '1px solid rgba(245, 158, 11, 0.3)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            color: '#f59e0b',
            marginBottom: '0.5rem'
          }}>
            <AlertTriangle size={28} />
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Storage Version Mismatch</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '580px', margin: 0, lineHeight: 1.5 }}>
            We detected a discrepancy between the data stored in this browser (local) and the workspace directory on the server.
            Please choose which version you want to keep.
          </p>
        </div>

        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', 
          gap: '1.5rem',
          marginTop: '0.5rem'
        }}>
          {/* Local Version Card */}
          <div 
            style={{
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              padding: '1.5rem',
              backgroundColor: 'var(--bg-tertiary)',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '1.25rem',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent)' }}>
                <Laptop size={18} />
                <span style={{ fontWeight: 600, fontSize: '1rem' }}>Local Browser Version</span>
              </div>
              
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div>
                  <strong style={{ color: 'var(--text-primary)' }}>Book Title:</strong> {localTitle}
                </div>
                <div>
                  <strong style={{ color: 'var(--text-primary)' }}>Chapters ({localDocs.length}):</strong>
                  <div style={{ 
                    maxHeight: '120px', 
                    overflowY: 'auto', 
                    border: '1px solid var(--border-color)', 
                    borderRadius: '6px', 
                    padding: '0.5rem', 
                    marginTop: '0.25rem',
                    backgroundColor: 'rgba(0,0,0,0.1)'
                  }}>
                    {localDocs.length === 0 ? (
                      <span style={{ fontStyle: 'italic' }}>No chapters</span>
                    ) : (
                      localDocs.map((doc: any, i: number) => (
                        <div key={doc.id || i} style={{ padding: '0.15rem 0', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                          {doc.title || `Chapter ${i + 1}`}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            <button
              onClick={() => handleResolve('local')}
              disabled={resolving}
              className="btn-primary"
              style={{
                width: '100%',
                padding: '0.75rem',
                justifyContent: 'center',
                backgroundColor: 'rgba(var(--accent-rgb), 0.15)',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              {resolving ? <RefreshCw size={16} className="animate-spin" /> : 'Use Local Browser Version'}
            </button>
          </div>

          {/* Server Version Card */}
          <div 
            style={{
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              padding: '1.5rem',
              backgroundColor: 'var(--bg-tertiary)',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '1.25rem',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#10b981' }}>
                <Server size={18} />
                <span style={{ fontWeight: 600, fontSize: '1rem' }}>Server-Side Version</span>
              </div>
              
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div>
                  <strong style={{ color: 'var(--text-primary)' }}>Book Title:</strong> {serverTitle}
                </div>
                <div>
                  <strong style={{ color: 'var(--text-primary)' }}>Chapters ({serverDocs.length}):</strong>
                  <div style={{ 
                    maxHeight: '120px', 
                    overflowY: 'auto', 
                    border: '1px solid var(--border-color)', 
                    borderRadius: '6px', 
                    padding: '0.5rem', 
                    marginTop: '0.25rem',
                    backgroundColor: 'rgba(0,0,0,0.1)'
                  }}>
                    {serverDocs.length === 0 ? (
                      <span style={{ fontStyle: 'italic' }}>No chapters</span>
                    ) : (
                      serverDocs.map((doc: any, i: number) => (
                        <div key={doc.id || i} style={{ padding: '0.15rem 0', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                          {doc.title || `Chapter ${i + 1}`}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            <button
              onClick={() => handleResolve('server')}
              disabled={resolving}
              className="btn-primary"
              style={{
                width: '100%',
                padding: '0.75rem',
                justifyContent: 'center',
                backgroundColor: '#10b981',
                color: '#ffffff',
                border: 'none',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              {resolving ? <RefreshCw size={16} className="animate-spin" /> : 'Use Server-Side Version'}
            </button>
          </div>
        </div>

        <div style={{ 
          fontSize: '0.8rem', 
          color: 'var(--text-muted)', 
          textAlign: 'center', 
          marginTop: '0.5rem',
          borderTop: '1px solid var(--border-color)',
          paddingTop: '1rem' 
        }}>
          Selecting a version will overwrite the other storage location to ensure they are synchronized. 
          You can toggle offline browser-only mode anytime under Settings &gt; Storage &amp; Sync.
        </div>
      </div>
    </div>
  )
}
