import { useSyncExternalStore } from 'react'

/**
 * Whether the global upload dialog is open (SPA-108).
 *
 * §3.1 entry point 3 is three surfaces — the `/documents` header, the
 * chassis, and ⌘K — and one dialog. Threading an `onOpenUpload` prop through
 * them would mean three props, two `AppSidebar` mount sites and a palette
 * that has never taken a callback for anything; a store means a surface opens
 * the dialog by calling a function, and the fourth surface that wants it
 * adds nothing here at all.
 *
 * The dialog itself is mounted **once**, in the app shell, which is what lets
 * an upload outlive the sheet it was started from: closing the dialog closes
 * Radix's content, not the component, so the in-flight rows keep running in
 * the component's own state (see `upload-dialog.tsx`). So this store carries
 * the flag and nothing else — the uploads are not state a second surface
 * ever needs to read.
 *
 * `useSyncExternalStore` for the same reason `chassis-store.ts` uses it: the
 * server render and the first client render have to agree, and both say
 * closed.
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
