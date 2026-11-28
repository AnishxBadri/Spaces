import { useId } from 'react'
import { weekdayOf } from '@spaces/core/format'
import { cn } from '#/lib/utils'

/**
 * The pine dither the large leaf casts, offset 4px down and right: the
 * 2px checker the file viewer's head glyph casts.
 */
function LeafShadow() {
  const id = useId()
  return (
    <svg
      aria-hidden
      width="56"
      height="60"
      viewBox="0 0 56 60"
      shapeRendering="crispEdges"
      className="absolute top-1 left-1"
    >
      <defs>
        <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse">
          <rect x="0" y="0" width="2" height="2" fill="var(--primary)" />
          <rect x="2" y="2" width="2" height="2" fill="var(--primary)" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="56" height="60" fill={`url(#${id})`} />
    </svg>
  )
}

/**
 * A day as a leaf torn from a desk calendar: the weekday in mono caps over
 * the day number in serif, in an ink outline. Today's head is an ink strip
 * that reads `TODAY`.
 * - `small` is the agenda's margin leaf, 44 by 48.
 * - `large` heads a meeting's sheet, 56 by 60, casting the pine dither;
 *   a cancelled meeting's leaf goes graphite with its number struck.
 */
export function DateLeaf({
  day,
  today,
  size = 'small',
  cancelled = false,
  className,
}: {
  /** The local day, `YYYY-MM-DD`. */
  day: string
  /** The reader's local day, `YYYY-MM-DD`. */
  today: string
  size?: 'small' | 'large' | undefined
  cancelled?: boolean | undefined
  className?: string | undefined
}) {
  const isToday = day === today
  const number = Number(day.slice(8, 10))
  if (size === 'large') {
    const edge = cancelled ? 'border-graphite' : 'border-hairline'
    return (
      <div
        data-date-leaf="large"
        {...(isToday ? { 'data-today': '' } : {})}
        className={cn('relative h-16 w-15 shrink-0', className)}
      >
        <LeafShadow />
        <div
          className={cn(
            'absolute top-0 left-0 flex h-15 w-14 flex-col border bg-paper',
            edge,
          )}
        >
          <span
            className={cn(
              'flex h-5 shrink-0 items-center justify-center mono text-field tracking-[0.08em] uppercase',
              isToday && !cancelled
                ? 'bg-hairline text-paper'
                : cn('border-b text-graphite', edge),
            )}
          >
            {isToday ? 'Today' : weekdayOf(day)}
          </span>
          <span
            className={cn(
              'flex flex-1 items-center justify-center font-serif text-display font-semibold',
              cancelled ? 'text-graphite line-through' : 'text-foreground',
            )}
          >
            {number}
          </span>
        </div>
      </div>
    )
  }
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
        {number}
      </span>
    </div>
  )
}
