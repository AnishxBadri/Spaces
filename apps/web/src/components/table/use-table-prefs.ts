import { useEffect, useState } from 'react'
import type { ColumnSizingState, VisibilityState } from '@tanstack/react-table'
import { tablePrefsOf } from '#/lib/table-prefs'
import type { TablePrefs } from '#/lib/table-prefs'

/**
 * Which columns are shown and how wide they are, remembered per object kind.
 * Local to the browser on purpose: the column state a single operator expects
 * to survive a reload, not a stand-in for shared, server-side saved views.
 */
export function useTablePrefs(key: string) {
  const [prefs, setPrefs] = useState<TablePrefs>(() => {
    if (typeof localStorage === 'undefined')
      return { columnVisibility: {}, columnSizing: {} }
    try {
      return tablePrefsOf(localStorage.getItem(key))
    } catch {
      // A storage the browser refuses to read, as in some private modes.
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
