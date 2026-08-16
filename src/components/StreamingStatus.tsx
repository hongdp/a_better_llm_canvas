import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

/**
 * The live status line under the chat while a generation runs.
 *
 * Problem: a slow model (grok-4.6 measured at 40–70s to its first token) left
 *   the UI completely silent — same spinner, same text, no way to tell a
 *   thinking model from a dead connection.
 * Fix: separate "waiting for the first token" from "streaming", and count the
 *   seconds. The wait is unchanged; it is merely legible now.
 */
interface StreamingStatusProps {
  /** Localized description of what is running, e.g. "Grok is streaming changes...". */
  label: string
  /** Localized stand-in shown until the first token lands. */
  waitingLabel: string
  /** True while the model has produced nothing yet. */
  waiting: boolean
}

/** Below this the counter is noise rather than reassurance. */
const SHOW_ELAPSED_AFTER_SECONDS = 2

export function StreamingStatus({ label, waitingLabel, waiting }: StreamingStatusProps) {
  const [elapsed, setElapsed] = useState(0)

  // Mounted for exactly one generation (the parent renders it only while
  // streaming), so the start time is this component's own lifetime.
  useEffect(() => {
    const startedAt = Date.now()
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
      padding: '0.25rem 0.5rem',
      fontSize: '0.8rem',
      color: 'var(--text-muted)'
    }}>
      <RefreshCw size={12} className="animate-spin" />
      <span>{waiting ? waitingLabel : label}</span>
      {elapsed >= SHOW_ELAPSED_AFTER_SECONDS && (
        <span style={{ opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>{elapsed}s</span>
      )}
    </div>
  )
}
