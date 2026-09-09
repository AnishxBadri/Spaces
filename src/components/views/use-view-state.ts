import { useMemo, useState } from 'react'
import type { SortingState, VisibilityState } from '@tanstack/react-table'
import { matchesConditions } from '#/lib/views/filter'
import type { Condition, ViewExtra } from '#/lib/views/filter'
import type { ViewRow } from '#/lib/views/store'
import type { ViewSnapshot } from './view-bar'

/**
 * The page-side half of views: holds conditions, sort, column visibility,
 * and page extra; applies the `?view=` view on load and whenever the id
 * changes; exposes the snapshot the bar compares and saves. Column widths
 * stay in local prefs — they're about your screen, not the view.
 *
 * Applying is derived state set during render, not an effect: the first
 * render already shows the view (no flash of "All"), and there is no
 * effect for React's concurrent lanes to interleave with.
 */
export function useViewState<TExtra extends ViewExtra>({
  views,
  activeId,
  columnVisibility,
  setColumnVisibility,
  defaultExtra,
}: {
  views: Array<ViewRow>
  activeId: string | null
  columnVisibility: VisibilityState
  setColumnVisibility: (v: VisibilityState) => void
  defaultExtra: TExtra
}) {
  const active = useMemo(
    () => views.find((v) => v.id === activeId) ?? null,
    [views, activeId],
  )
  const fromView = (v: ViewRow | null) => ({
    conditions: v?.filter ?? [],
    sorting: (v?.sort ? [v.sort] : []) as SortingState,
    extra: { ...defaultExtra, ...((v?.extra ?? {}) as Partial<TExtra>) },
  })

  const [conditions, setConditions] = useState<Array<Condition>>(
    () => fromView(active).conditions,
  )
  const [sorting, setSorting] = useState<SortingState>(
    () => fromView(active).sorting,
  )
  const [extra, setExtra] = useState<TExtra>(() => fromView(active).extra)
  const [appliedId, setAppliedId] = useState<string | null>(activeId)

  function apply(v: ViewRow | null) {
    const next = fromView(v)
    setConditions(next.conditions)
    setSorting(next.sorting)
    setExtra(next.extra)
    if (v) setColumnVisibility(v.columns)
    setAppliedId(v?.id ?? null)
  }

  // The URL changed to another view (back/forward, a pasted link): re-sync.
  if (activeId !== appliedId) apply(active)

  const snapshot: ViewSnapshot = {
    filter: conditions,
    sort: sorting[0] ? { id: sorting[0].id, desc: sorting[0].desc } : null,
    columns: columnVisibility,
    extra,
  }

  const rowMatches = (
    values: Record<string, unknown>,
    typeOf: (slug: string) => string | undefined,
  ) => matchesConditions(values, conditions, typeOf)

  return {
    conditions,
    setConditions,
    sorting,
    setSorting,
    extra,
    setExtra,
    snapshot,
    apply,
    rowMatches,
  }
}
