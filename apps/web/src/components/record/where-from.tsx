import { useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import type { WhereFrom } from '#/lib/server-fns'

/** `2026-10-04T09:00:00Z` → `10-04`: the day, as the printed sheets write it. */
export const dayOf = (iso: string): string => iso.slice(5, 10)

/** "Apollo · 10-04 · was 42 on 07-12" — the popover in one line. */
export function whereFromWords(from: WhereFrom): string {
  return [
    from.source,
    dayOf(from.at),
    ...from.earlier.map(
      (e) => `was ${e.value}${e.at === null ? '' : ` on ${dayOf(e.at)}`}`,
    ),
  ].join(' · ')
}

/**
 * A filled value's where-from: a small square after the value that
 * opens, on hover or focus, the source that filled it, the day, and — for
 * a changing figure — its earlier values with their days. Dithered, as
 * every popover is.
 */
export function WhereFromMark({
  label,
  from,
}: {
  /** The attribute's name, for the trigger's accessible name. */
  label: string
  from: WhereFrom
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${whereFromWords(from)}`}
          data-where-from
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className="focus-ring flex size-4 shrink-0 items-center justify-center"
        >
          <span aria-hidden className="size-2 border border-graphite" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-64 flex-col p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex h-9 items-center gap-2 border-b border-rule px-3">
          <span
            aria-hidden
            className="flex size-4 shrink-0 items-center justify-center bg-foreground mono text-micro text-paper"
          >
            {from.source.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-ui text-foreground">
            Filled by {from.source}
          </span>
          <span className="mono text-micro text-graphite">
            {dayOf(from.at)}
          </span>
        </div>
        {from.earlier.length === 0 ? null : (
          <ol className="flex flex-col gap-1 px-3 py-2.5">
            {from.earlier.map((e, i) => (
              <li key={i} className="mono text-micro text-graphite">
                was {e.value}
                {e.at === null ? '' : ` on ${dayOf(e.at)}`}
              </li>
            ))}
          </ol>
        )}
      </PopoverContent>
    </Popover>
  )
}
