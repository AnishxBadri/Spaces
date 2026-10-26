import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { dayKey } from '@spaces/core/format'

const ClockContext = createContext<string | null>(null)

/** Hands the shell loader's `now` to every date printed beneath it. */
export function ClockProvider({
  now,
  children,
}: {
  now: string
  children: ReactNode
}) {
  return <ClockContext.Provider value={now}>{children}</ClockContext.Provider>
}

/**
 * The instant the page was loaded at, and its local day — what a printed
 * date is measured against.
 * - Under the shell both come from its loader, so the server and the
 *   browser print the same string.
 * - Outside it (a component rendered alone, as a test does) the clock is
 *   read, which is safe only because nothing there is hydrated.
 */
export function useClock(): { now: string; today: string } {
  const now = useContext(ClockContext) ?? new Date().toISOString()
  return { now, today: dayKey(now) }
}
