import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '#/lib/utils'

/**
 * The selection bar: 44px on bone while a row is checked — the count, then
 * the surface's controls, its one pine verb last. It takes the place of the
 * row it sits on (a filter row, a toolbar line) rather than pushing rows down.
 */
export function SelectionBar({
  label,
  count,
  children,
  className,
}: {
  /** Accessible name for the toolbar — "Selected companies". */
  label: string
  count: number
  children: ReactNode
  className?: string
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-selection-bar
      className={cn(
        'flex h-11 items-center gap-3 border-b border-rule bg-bone px-3',
        className,
      )}
    >
      <span className="tabular shrink-0 mono text-label">{count} selected</span>
      {children}
    </div>
  )
}

/** A table's checked rows, by key: what `RecordTable` and its bar share. */
export type RowSelection = {
  readonly has: (key: string) => boolean
  readonly set: (keys: ReadonlyArray<string>, on: boolean) => void
  readonly clear: () => void
  /** The checked keys among `keys`, in their order. */
  readonly among: (keys: ReadonlyArray<string>) => Array<string>
  /** Any row is checked: the checkboxes stay visible. */
  readonly active: boolean
}

export function useRowSelection(): RowSelection {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set())
  const set = useCallback((changed: ReadonlyArray<string>, on: boolean) => {
    setKeys((prev) => {
      const next = new Set(prev)
      for (const k of changed) {
        if (on) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }, [])
  const clear = useCallback(() => setKeys(new Set()), [])
  return useMemo(
    () => ({
      has: (k: string) => keys.has(k),
      set,
      clear,
      among: (all: ReadonlyArray<string>) => all.filter((k) => keys.has(k)),
      active: keys.size > 0,
    }),
    [keys, set, clear],
  )
}
