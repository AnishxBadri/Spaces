import { useSyncExternalStore } from 'react'
import type { ThreadKind } from './threads'

/**
 * What the log window and a record's Interactions tab tell each other in
 * the browser: the kind the tab is filtered to, so the head's `Log
 * interaction` opens on it, and the interaction just logged, on bone in its
 * row until its toast goes. Client state only; the server render reads
 * neither.
 */

/** The kinds the log window writes. */
export type LoggableKind = 'call' | 'meeting'

function cell<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      for (const l of listeners) l()
    },
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}

const filter = cell<{ recordId: string; kind: LoggableKind } | null>(null)
const logged = cell<string | null>(null)

/**
 * The Interactions tab's filter while the tab is on screen: Calls or
 * Meetings is remembered for its record, anything else (or the tab going
 * away, as `null`) forgets it.
 */
export function setInteractionsFilter(
  recordId: string,
  kind: ThreadKind | null,
): void {
  if (kind === 'call' || kind === 'meeting') filter.set({ recordId, kind })
  else if (filter.get()?.recordId === recordId) filter.set(null)
}

/** The kind the log window opens on for this record; null for its own default. */
export function useLogKindFor(recordId: string): LoggableKind | null {
  const f = useSyncExternalStore(filter.subscribe, filter.get, () => null)
  return f !== null && f.recordId === recordId ? f.kind : null
}

/** The interaction just logged: its row sits on bone until `clearLogged`. */
export function markLogged(id: string): void {
  logged.set(id)
}

/** The highlight goes, unless a later log has taken it. */
export function clearLogged(id: string): void {
  if (logged.get() === id) logged.set(null)
}

/** The interaction whose row is on bone for having just been logged. */
export function useLoggedInteraction(): string | null {
  return useSyncExternalStore(logged.subscribe, logged.get, () => null)
}
