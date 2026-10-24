import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { DitherBlock } from './dither'

/**
 * Empty state: a dither block, one serif sentence, one sans line, one
 * primary action carrying its key. It teaches what the surface will do in
 * two sentences or less and offers the create action when the backend
 * exists. The dither block is the picture; `icon` is accepted and not drawn.
 */
export function EmptyState({
  title,
  body,
  action,
  hint,
}: {
  icon?: LucideIcon
  title: string
  body: string
  action?: ReactNode
  hint?: string
}) {
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <DitherBlock />
        <h2 className="font-serif text-xl leading-6 font-semibold">{title}</h2>
        <p className="max-w-70 text-ui leading-5 text-graphite">{body}</p>
        {action ? <div>{action}</div> : null}
        {hint ? <p className="mono text-micro text-graphite">{hint}</p> : null}
      </div>
    </div>
  )
}
