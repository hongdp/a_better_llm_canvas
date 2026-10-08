/**
 * `run.*` events from the book's event stream (store/bookEvents), handed to
 * whoever renders runs — the chat hook. A tiny emitter rather than store
 * state: deltas arrive per token, and the hook paints them with its own
 * throttles instead of re-rendering the app for each.
 */
import type { ServerRunEvent } from '../services/serverRuns'

type Listener = (event: ServerRunEvent) => void
const listeners = new Set<Listener>()

export function onRunEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function emitRunEvent(event: ServerRunEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (e) {
      console.error('[runEvents] listener failed', e)
    }
  }
}
