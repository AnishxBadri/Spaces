import { useSyncExternalStore } from 'react'

/**
 * The last tab used on a kind of record, per browser like `chassis-prefs`:
 * the next record of that kind opens on it when its link names no tab.
 * - The server render and the first client render read null (the default
 *   tab); the stored tab snaps in after hydration.
 * - The value is a plain string; the page decides whether it is one of its
 *   tabs, so a stale or foreign value falls back to the default.
 */

const keyOf = (kind: string) => `record-tab:${kind}`

const listeners = new Set<() => void>()

function read(kind: string): string | null {
  try {
    return localStorage.getItem(keyOf(kind))
  } catch {
    return null
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith('record-tab:')) cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

export function useLastRecordTab(kind: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => read(kind),
    () => null,
  )
}

export function rememberRecordTab(kind: string, tab: string) {
  try {
    localStorage.setItem(keyOf(kind), tab)
  } catch {
    /* private mode / quota — the tab is not remembered, nothing else is lost */
  }
  for (const l of listeners) l()
}
