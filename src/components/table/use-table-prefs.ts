import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { ColumnSizingState, VisibilityState } from '@tanstack/react-table'

type Prefs = {
  columnVisibility: VisibilityState
  columnSizing: ColumnSizingState
}

/** localStorage is a boundary like any other: decoded, never asserted. */
const storedPrefs = z.object({
  columnVisibility: z.record(z.string(), z.boolean()).optional(),
  columnSizing: z.record(z.string(), z.number()).optional(),
})

/**
 * Which columns are shown and how wide they are, remembered per object kind.
 * Local to the browser on purpose — saved *views* (shared, server-side) are
 * deferred, and this is the column state a single operator expects to survive
 * a reload, not a feature standing in for them.
 */
export function useTablePrefs(key: string) {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    if (typeof localStorage === 'undefined')
      return { columnVisibility: {}, columnSizing: {} }
    try {
      const stored = storedPrefs.safeParse(
        JSON.parse(localStorage.getItem(key) ?? '{}'),
      )
      return {
        columnVisibility: stored.data?.columnVisibility ?? {},
        columnSizing: stored.data?.columnSizing ?? {},
      }
    } catch {
      return { columnVisibility: {}, columnSizing: {} }
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(prefs))
    } catch {
      /* private mode / quota — column widths are not worth an error toast */
    }
  }, [key, prefs])

  return {
    columnVisibility: prefs.columnVisibility,
    columnSizing: prefs.columnSizing,
    setColumnVisibility: (
      updater: VisibilityState | ((old: VisibilityState) => VisibilityState),
    ) =>
      setPrefs((p) => ({
        ...p,
        columnVisibility:
          typeof updater === 'function' ? updater(p.columnVisibility) : updater,
      })),
    setColumnSizing: (
      updater:
        ColumnSizingState | ((old: ColumnSizingState) => ColumnSizingState),
    ) =>
      setPrefs((p) => ({
        ...p,
        columnSizing:
          typeof updater === 'function' ? updater(p.columnSizing) : updater,
      })),
  }
}
