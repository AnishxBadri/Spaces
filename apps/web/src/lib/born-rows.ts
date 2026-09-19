import { useCallback, useState } from 'react'

/**
 * "Born this session" — the marker the composer wash is driven off
 * (DESIGN.md §5, Micro-interactions; SPA-53).
 *
 * The contract the wash has to keep is the negative one: a row that was
 * already on the page when the list loaded must never wash. `createdAt`
 * alone cannot decide that — reload a list ten seconds after adding a task
 * and every fresh row would flash again, for something nobody just did here.
 * So the set starts empty on mount and grows only when a composer reports
 * the id its own write returned. A row the session did not create is not in
 * it, by construction, and a reload empties it.
 *
 * Membership is permanent for the life of the list: the wash is a CSS
 * animation that plays once when the row mounts, so keeping the id costs a
 * `Set` entry and buys a guarantee that a re-render or a re-sort can never
 * replay it.
 */

const NONE: ReadonlySet<string> = new Set()

/**
 * The next born-set after a composer reports rows. Returns the *same* set
 * when it already holds every id, so a repeated report is not a re-render.
 */
export function addBorn(
  born: ReadonlySet<string>,
  ids: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (ids.every((id) => born.has(id))) return born
  const next = new Set(born)
  for (const id of ids) next.add(id)
  return next
}

export type BornRows = {
  /** True only for a row one of this page's composers created. */
  washes: (id: string) => boolean
  /** What a composer calls with the id its write returned. */
  bear: (...ids: Array<string>) => void
}

/** The hook a list holds; `bear` is stable, `washes` changes with the set. */
export function useBornRows(): BornRows {
  const [born, setBorn] = useState(NONE)
  const bear = useCallback((...ids: Array<string>) => {
    setBorn((prev) => addBorn(prev, ids))
  }, [])
  const washes = useCallback((id: string) => born.has(id), [born])
  return { washes, bear }
}
