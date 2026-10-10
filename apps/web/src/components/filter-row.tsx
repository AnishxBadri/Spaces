import type { ReactNode } from 'react'
import { cn } from '#/lib/utils'

/**
 * The filter row a tab opens on: filters in the underline grammar, pine 2px
 * under the chosen one, and an optional end slot right. The space page's
 * tabs and a record's tabs share it.
 */

/** One filter: caps label, its count beside it. */
export function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'focus-ring-inset flex h-9 items-center gap-1.5 border-b-2 px-3 label-caps transition-colors duration-150 ease-out-quart',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-graphite hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

export function FilterRow({
  label,
  children,
  end,
}: {
  label: string
  children: ReactNode
  end?: ReactNode
}) {
  return (
    <div className="flex h-11 items-end justify-between gap-3 border-b border-rule px-3">
      <div role="group" aria-label={label} className="-ml-3 flex items-end">
        {children}
      </div>
      {end ? <div className="flex h-full items-center">{end}</div> : null}
    </div>
  )
}

/** A filter's count, in mono beside its label. */
export function FilterCount({ n }: { n: number }) {
  return <span className="tabular mono text-micro font-normal">{n}</span>
}
