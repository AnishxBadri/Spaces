import { weekdayOf } from '@spaces/core/format'
import { cn } from '#/lib/utils'

/**
 * A day as a leaf torn from a desk calendar: the weekday in mono caps over
 * the day number in serif, in an ink outline. Today's head is an ink strip
 * that reads `TODAY`. `small` is the agenda's margin leaf, 44 by 48.
 */
export function DateLeaf({
  day,
  today,
  size = 'small',
  className,
}: {
  /** The local day, `YYYY-MM-DD`. */
  day: string
  /** The reader's local day, `YYYY-MM-DD`. */
  today: string
  size?: 'small' | undefined
  className?: string | undefined
}) {
  const isToday = day === today
  return (
    <div
      data-date-leaf={size}
      {...(isToday ? { 'data-today': '' } : {})}
      className={cn(
        'flex h-12 w-11 shrink-0 flex-col border border-hairline bg-paper',
        className,
      )}
    >
      <span
        className={cn(
          'flex h-4 shrink-0 items-center justify-center label-caps',
          isToday
            ? 'bg-hairline text-paper'
            : 'border-b border-hairline text-graphite',
        )}
      >
        {isToday ? 'Today' : weekdayOf(day)}
      </span>
      <span className="flex flex-1 items-center justify-center font-serif text-xl leading-6 font-semibold text-foreground">
        {Number(day.slice(8, 10))}
      </span>
    </div>
  )
}
