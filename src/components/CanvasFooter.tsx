import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { CanvasDocument } from '../store/useAppStore'
import { countWords } from '../utils/text'

interface CanvasFooterProps {
  activeDoc: Pick<CanvasDocument, 'title' | 'content'>
}

/**
 * Canvas status footer: word count, session token stats, storage size, and
 * the active chapter name. Extracted from App.tsx unchanged (same
 * DOM/classes, including the footer-stats/footer-secondary CSS hooks).
 */
export function CanvasFooter({ activeDoc }: CanvasFooterProps) {
  const {
    sessionInputTokens,
    sessionCacheHitTokens,
    sessionCacheMissTokens,
    sessionOutputTokens
  } = useAppStore()

  const [storageSize] = useState('0 B')

  return (
    <footer className="canvas-footer">
      {/* No flex-wrap: the footer is a fixed-height single row.
          Wrapped rows would be clipped vertically (this hid the
          word count on phones); narrow screens scroll instead and
          secondary stats are hidden via CSS. */}
      <div className="footer-stats">
        <span className="footer-words">Words: {countWords(activeDoc.content)}</span>
        <span className="footer-sep" style={{ opacity: 0.3 }}>|</span>
        <span className="footer-tokens">
          Session Tokens: In: {sessionInputTokens.toLocaleString()}
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
            (Hit: {sessionCacheHitTokens.toLocaleString()} / Miss: {sessionCacheMissTokens.toLocaleString()})
          </span>
          / Out: {sessionOutputTokens.toLocaleString()}
        </span>
        <span className="footer-sep footer-secondary" style={{ opacity: 0.3 }}>|</span>
        <span className="footer-storage footer-secondary">Storage: {storageSize}</span>
      </div>
      <div className="footer-chapter footer-secondary">Active Chapter: {activeDoc.title}</div>
    </footer>
  )
}
