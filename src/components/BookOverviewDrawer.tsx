import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Sparkles, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { enqueueSummaryRefresh, subscribeSummaryQueue, type SummaryQueueStatus } from '../services/chapterSummaries'
import { isSummaryStale, MIN_CHARS_FOR_SUMMARY } from '../utils/chapterIndex'
import { OVERVIEW_HEIGHT, clampSize, loadPersistedSize, savePersistedSize } from '../utils/layoutPrefs'
import { useTranslation } from '../i18n'

interface BookOverviewDrawerProps {
  layoutMode: 'desktop' | 'portrait' | 'landscape' | 'tablet-square'
  onClose: () => void
}

/**
 * The book overview: every chapter beside the summary the assistant actually
 * reads for it, in the document area where there is room to read.
 *
 * Exists because the only other place summaries appeared was a 0.72rem
 * expander inside a 240px sidebar — fine for a glance, useless for judging
 * whether 350 summaries are any good. On desktop it is a height-adjustable
 * drawer over the editor; on phone layouts it covers the document area
 * outright, since half-covering a phone screen serves nobody.
 */
export function BookOverviewDrawer({ layoutMode, onClose }: BookOverviewDrawerProps) {
  const { t } = useTranslation()
  const documents = useAppStore(state => state.documents)
  const activeDocumentId = useAppStore(state => state.activeDocumentId)
  const setActiveDocument = useAppStore(state => state.setActiveDocumentId)
  const isStreaming = useAppStore(state => state.isStreaming)

  const isPhone = layoutMode !== 'desktop'

  const [queue, setQueue] = useState<SummaryQueueStatus>({
    pending: 0, running: false, waitingForChat: false, lastError: null, completedThisRun: 0
  })
  useEffect(() => subscribeSummaryQueue(setQueue), [])

  const [height, setHeight] = useState(() =>
    loadPersistedSize(OVERVIEW_HEIGHT.key, OVERVIEW_HEIGHT.fallback, OVERVIEW_HEIGHT.bounds))

  // Pointer events, not mouse events: the same handle must work with touch.
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null)
  const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
    dragState.current = { startY: e.clientY, startHeight: height }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [height])
  const onHandlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return
    setHeight(clampSize(dragState.current.startHeight + (e.clientY - dragState.current.startY), OVERVIEW_HEIGHT.bounds))
  }, [])
  const onHandlePointerUp = useCallback(() => {
    if (!dragState.current) return
    dragState.current = null
    setHeight(current => {
      savePersistedSize(OVERVIEW_HEIGHT.key, current, OVERVIEW_HEIGHT.bounds)
      return current
    })
  }, [])

  const summarize = (docId: string) => {
    void useAppStore.getState().ensureDocumentContents([docId]).then(() => {
      enqueueSummaryRefresh(docId, true)
    })
  }

  return (
    <div
      className="book-overview-drawer"
      style={{
        height: isPhone ? '100%' : height,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderBottom: isPhone ? 'none' : '1px solid var(--border-color)',
        backgroundColor: 'var(--bg-secondary)',
        overflow: 'hidden'
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.5rem 0.9rem', borderBottom: '1px solid var(--border-color)', flexShrink: 0
      }}>
        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
          {t.overview.title.replace('{count}', String(documents.length))}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {queue.waitingForChat && queue.pending > 0 ? (
            <span><RefreshCw size={11} /> {t.sidebar.summaryWaitingForChat.replace('{pending}', String(queue.pending))}</span>
          ) : (queue.running || queue.pending > 0) ? (
            <span><RefreshCw size={11} className="animate-spin" /> {t.sidebar.summaryProgress
              .replace('{done}', String(queue.completedThisRun))
              .replace('{pending}', String(queue.pending))}</span>
          ) : queue.lastError ? (
            <span>⚠️ {queue.lastError.slice(0, 60)}</span>
          ) : null}
          <button onClick={onClose} className="btn-icon" title={t.overview.close} type="button" style={{ padding: '0.25rem' }}>
            <X size={15} />
          </button>
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0.4rem 0.9rem 0.9rem' }}>
        {documents.map(doc => {
          const tooShort = doc.contentLoaded !== false && doc.content.length < MIN_CHARS_FOR_SUMMARY
          const stale = !!doc.summary && isSummaryStale(doc)
          return (
            <div key={doc.id} style={{ padding: '0.55rem 0', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button
                  onClick={() => { setActiveDocument(doc.id); if (isPhone) onClose() }}
                  className="btn-icon"
                  type="button"
                  style={{
                    padding: 0, fontSize: '0.82rem', fontWeight: 600,
                    color: doc.id === activeDocumentId ? 'var(--accent)' : 'var(--text-primary)',
                    textAlign: 'left', flex: 1, minWidth: 0, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}
                  title={doc.title}
                >
                  {doc.title}
                </button>
                {stale && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--accent)', flexShrink: 0 }}>{t.overview.stale}</span>
                )}
                {!tooShort && (
                  <button
                    onClick={() => summarize(doc.id)}
                    disabled={isStreaming}
                    className="btn-icon"
                    title={t.sidebar.refreshSummary}
                    type="button"
                    style={{ padding: '0.3rem', flexShrink: 0 }}
                  >
                    <Sparkles size={13} />
                  </button>
                )}
              </div>
              <div style={{
                marginTop: '0.3rem', fontSize: '0.78rem', lineHeight: 1.6,
                color: doc.summary ? 'var(--text-secondary)' : 'var(--text-muted)',
                whiteSpace: 'pre-wrap'
              }}>
                {doc.summary || (tooShort ? t.overview.tooShort : t.overview.notSummarized)}
              </div>
            </div>
          )
        })}
      </div>

      {!isPhone && (
        <div
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          style={{
            height: 8, cursor: 'row-resize', flexShrink: 0,
            borderTop: '1px solid var(--border-color)',
            backgroundColor: 'var(--bg-tertiary)', touchAction: 'none'
          }}
          title={t.overview.dragToResize}
        />
      )}
    </div>
  )
}
