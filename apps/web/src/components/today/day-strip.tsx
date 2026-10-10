import { useEffect, useId, useState } from 'react'
import { cellsFor } from '#/components/dither'

/** The working window the strip draws, in hours. */
export const DAY_START = 8
export const DAY_END = 20
/** The hours the axis labels, every two. */
const LABELS = Array.from(
  { length: (DAY_END - DAY_START) / 2 + 1 },
  (_, i) => DAY_START + i * 2,
)
/** Elapsed time's density: Bayer 6 of 16, ink. */
const ELAPSED_LEVEL = 6

/** A meeting on the strip: an ink block under its name. */
export type DayStripMeeting = {
  id: string
  title: string
  /** ISO instants; the block is clipped to the window. */
  startsAt: string
  endsAt: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Where a local clock time falls on the window, 0–100, clamped. */
export function windowPercent(d: Date): number {
  const hours = d.getHours() + d.getMinutes() / 60
  const at = ((hours - DAY_START) / (DAY_END - DAY_START)) * 100
  return Math.min(100, Math.max(0, at))
}

/** The now label: `now · 11:40`. */
export function nowLabel(d: Date): string {
  return `now · ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The browser's clock, read after mount and once a minute. Null on the
 * server and on the first client render, so hydration never compares two
 * clocks.
 */
function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** An axis or block label's anchor: start-aligned at 0, end-aligned at 100. */
function anchor(at: number): string {
  if (at <= 0) return ''
  if (at >= 85) return '-translate-x-full'
  return '-translate-x-1/2'
}

/**
 * Today's working hours, 08–20, as a band under the head: the elapsed part
 * dithered up to a pine now-dot with `now · hh:mm` beside it. (D79)
 * - `meetings` are ink blocks with their names; Today passes them once a
 *   calendar source feeds the day.
 * - Dither cells stay 2px: the svg has no viewBox, so its user units are pixels.
 */
export function DayStrip({
  meetings = [],
}: {
  meetings?: ReadonlyArray<DayStripMeeting>
}) {
  const now = useNow()
  const pattern = useId()
  const at = now === null ? null : windowPercent(now)
  return (
    <div data-day-strip className="h-16 shrink-0 px-8">
      <div className="relative h-full">
        {meetings.map((m) => {
          const from = windowPercent(new Date(m.startsAt))
          const to = windowPercent(new Date(m.endsAt))
          if (to <= from) return null
          return (
            <span key={m.id}>
              <span
                data-meeting
                className="absolute top-1.5 max-w-40 truncate mono text-field text-foreground"
                style={{ left: `${from}%` }}
              >
                {m.title}
              </span>
              <span
                className="absolute top-5.5 h-4.5 bg-foreground"
                style={{ left: `${from}%`, width: `${to - from}%` }}
              />
            </span>
          )
        })}
        <svg
          aria-hidden
          width="100%"
          height="18"
          className="absolute inset-x-0 top-5.5"
        >
          <defs>
            <pattern
              id={pattern}
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
              shapeRendering="crispEdges"
            >
              {cellsFor(ELAPSED_LEVEL).map(([x, y]) => (
                <rect
                  key={`${x}-${y}`}
                  x={x}
                  y={y}
                  width="2"
                  height="2"
                  fill="var(--foreground)"
                />
              ))}
            </pattern>
          </defs>
          {at === null || at === 0 ? null : (
            <rect
              x="0"
              y="0"
              width={`${at}%`}
              height="18"
              fill={`url(#${pattern})`}
            />
          )}
        </svg>
        <span className="absolute inset-x-0 top-10 border-b border-hairline" />
        {now === null || at === null ? null : (
          <>
            <span
              data-now
              className="absolute top-6.75 size-2 -translate-x-1/2 bg-primary"
              style={{ left: `${at}%` }}
            />
            <span
              // Not cn(): tailwind-merge reads text-field as a colour.
              className={`absolute top-1.5 mono text-field whitespace-nowrap text-primary ${at >= 85 ? '-translate-x-full pr-3' : 'pl-3'}`}
              style={{ left: `${at}%` }}
            >
              {nowLabel(now)}
            </span>
          </>
        )}
        {LABELS.map((h) => {
          const left = ((h - DAY_START) / (DAY_END - DAY_START)) * 100
          return (
            <span
              key={h}
              aria-hidden
              className={`absolute top-11 mono text-field text-graphite ${anchor(left)}`}
              style={{ left: `${left}%` }}
            >
              {pad(h)}
            </span>
          )
        })}
      </div>
    </div>
  )
}
