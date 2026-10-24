import { useCallback, useState } from 'react'

/**
 * "Born this session" — the marker the composer wash is driven off.
 * - A row already on the page when the list loaded must never wash, so the
 *   set starts empty and grows only with ids a composer's own write returned
 *   (not `createdAt`, which would re-flash fresh rows after a reload).
 * - Membership lasts the life of the list, so a re-render or re-sort can
 *   never replay the one-shot CSS animation.
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
