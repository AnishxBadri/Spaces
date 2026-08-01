import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Teaching empty state — product register discipline: an empty surface
 * explains what it will do, in two sentences or less, and offers the
 * create action when the backend exists.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  hint,
}: {
  icon: LucideIcon
  title: string
  body: string
  action?: ReactNode
  hint?: string
}) {
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-5 flex size-11 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-5 text-muted-foreground" strokeWidth={1.75} />
        </div>
        <h2 className="text-title font-semibold">{title}</h2>
        <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
          {body}
        </p>
        {action ? <div className="mt-5">{action}</div> : null}
        {hint ? (
          <p className="mt-4 text-label text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  )
}
