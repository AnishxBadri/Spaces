import { useEffect, useState } from 'react'
import { getTodayHeadlines } from '#/lib/server-fns'
import type { TodayHeadlines } from '#/lib/server-fns'
import { dayWindow } from '#/lib/meetings/day'
import type { Settled } from '#/lib/today/use-settled'

/**
 * Today's headline count, read in the browser so the day is the reader's
 * clock, as the day's meetings are; a loader on the server would count the
 * server's day. Never read for a null day.
 * - `version` re-reads when it changes: the page passes its loader data, so
 *   a refresh counts again.
 * - A re-read keeps the last answer on screen until it lands.
 */
export function useTodayHeadlines(
  day: string | null,
  version: unknown,
): Settled<TodayHeadlines> {
  const [settled, setSettled] = useState<Settled<TodayHeadlines>>({
    state: 'pending',
  })
  useEffect(() => {
    if (day === null) return
    let live = true
    getTodayHeadlines({ data: dayWindow(day) }).then(
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
  }, [day, version])
  return settled
}
