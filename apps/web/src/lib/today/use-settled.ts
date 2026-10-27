import { useEffect, useState } from 'react'

/** A deferred read as a surface draws it. */
export type Settled<T> =
  { state: 'pending' } | { state: 'failed' } | { state: 'done'; value: T }

const PENDING = { state: 'pending' } as const

/**
 * Follow a promise a loader handed back unawaited, without suspending the
 * page around it.
 * - Pending until the first one settles; a newer promise (the loader ran
 *   again) keeps the last answer on screen until it settles in turn, so a
 *   refresh never flashes the loading row.
 * - The server render is always pending: the read lands in the browser.
 */
export function useSettled<T>(promise: Promise<T>): Settled<T> {
  const [settled, setSettled] = useState<Settled<T>>(PENDING)
  useEffect(() => {
    let live = true
    promise.then(
      (value) => {
        if (live) setSettled({ state: 'done', value })
      },
      () => {
        if (live) setSettled({ state: 'failed' })
      },
    )
    return () => {
      live = false
    }
  }, [promise])
  return settled
}
