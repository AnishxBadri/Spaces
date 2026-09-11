import { useSyncExternalStore } from 'react'

/**
 * Whether the chassis is collapsed to its 48px marks-only form. Local to the
 * browser (a viewport preference, not workspace state) and read through
 * useSyncExternalStore so the server render and the first client render
 * agree: both start expanded, and a collapsed reader's chassis snaps in after
 * hydration rather than tearing the markup.
 */
const KEY = 'chassis:collapsed'
const listeners = new Set<() => void>()

function read() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

export function setChassisCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(KEY, collapsed ? '1' : '0')
  } catch {
    /* private mode / quota — the preference is lost, nothing else is */
  }
  for (const l of listeners) l()
}

export function useChassisCollapsed() {
  return useSyncExternalStore(subscribe, read, () => false)
}
