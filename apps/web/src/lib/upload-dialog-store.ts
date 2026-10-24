import { useSyncExternalStore } from 'react'

/**
 * Whether the global upload dialog is open. Several surfaces (the `/files`
 * header, the chassis, ⌘K) open one dialog by calling a function, not by
 * threading a prop.
 * - The dialog is mounted once, in the app shell, so an upload outlives the
 *   sheet it started from; this store carries the flag and nothing else.
 * - `useSyncExternalStore`, so server and first client render agree: closed.
 */
let open = false
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function setUploadDialogOpen(next: boolean) {
  if (open === next) return
  open = next
  for (const l of listeners) l()
}

/** The one call an entry point makes. */
export function openUploadDialog() {
  setUploadDialogOpen(true)
}

export function useUploadDialogOpen() {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  )
}
