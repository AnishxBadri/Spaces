import type { IconComponent } from '#/components/icons'
import type { ReactNode } from 'react'
import { DitherNoun } from './dither-noun'
import type { NounKind } from './dither-noun'

/**
 * First run: nothing of this kind exists yet. The kind's drawing, one serif
 * title (`No tasks yet`), and the create action carrying its key. No
 * sentence under the title: the drawing and the button say what goes here.
 */
export function EmptyState({
  kind,
  title,
  action,
}: {
  kind: NounKind
  title: string
  action?: ReactNode
}) {
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <DitherNoun kind={kind} />
        <h2 className="font-serif text-xl leading-6 font-semibold">{title}</h2>
        {action ? <div>{action}</div> : null}
      </div>
    </div>
  )
}

/**
 * A tab or filter that matched nothing, when things do exist: one centred
 * line under the column head, a graphite icon and the absence, then a way
 * out only where there is one (`Show done`). No drawing, no button.
 */
export function EmptyLine({
  icon: Icon,
  children,
  action,
}: {
  icon: IconComponent
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-ui text-graphite">
      <Icon aria-hidden className="size-4 shrink-0" />
      <span>{children}</span>
      {action ? <span className="text-foreground">{action}</span> : null}
    </div>
  )
}
