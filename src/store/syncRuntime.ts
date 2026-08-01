/**
 * Module-level mutable sync-runtime flags, kept in exactly ONE module so
 * every user sees the same value. They are shared by the books/auth slices
 * (bulk state swaps must pause auto-save), the server bootstrap
 * (serverSync.ts), and the auto-save subscription (useAppStore.ts).
 * ESM imports are read-only views, so a plain `export let` could not be
 * reassigned by importers — hence the accessor functions.
 */

// Guards the auto-save subscription: while false, store updates only refresh
// the change-tracking baseline instead of scheduling a server sync. Toggled
// off during bulk state swaps (book create/switch) and set once the local
// bootstrap in initializeStoreFromServer completes.
let isInitialized = false

export const getIsInitialized = (): boolean => isInitialized

export const setIsInitialized = (value: boolean) => {
  isInitialized = value
}

// Debounce handle for the auto-save subscription's syncToServer timer.
let saveTimeout: ReturnType<typeof setTimeout> | null = null

/** Cancel a pending debounced save, if any (book switch/create, logout). */
export const clearPendingSave = () => {
  if (saveTimeout) {
    clearTimeout(saveTimeout)
    saveTimeout = null
  }
}

/** (Re)arm the debounced save timer, replacing any pending one. */
export const schedulePendingSave = (callback: () => void, delayMs: number) => {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(callback, delayMs)
}
