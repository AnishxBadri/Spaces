import type { ReactNode } from 'react'

/** A centred mono divider across a column: a scope change, a day, a saved watch. */
export function Divider({ children }: { children: ReactNode }) {
  return (
    <div
      role="separator"
      className="flex items-center gap-3 mono text-micro text-graphite"
    >
      <span className="h-px flex-1 bg-rule" />
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-rule" />
    </div>
  )
}
