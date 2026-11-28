import { Link } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import { formatTime } from '@spaces/core/format'
import { cellsFor } from '#/components/dither'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { dayLabel, dayTense, shiftDay, stripHead } from '#/lib/meetings/day'

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

/** A meeting on the strip: an ink block under its label. */
export type DayStripMeeting = {
  id: string
  /** The first linked record, else who, else the title (`stripLabel`). */
  label: string
  title: string
  /** `Priya Raman +1`; null when nobody outside the workspace is on it. */
  who: string | null
  /** ISO instants; the block is clipped to the window. */
  startsAt: string
  endsAt: string
  /** The call's address, for `Join ↗`; null for a meeting in a room. */
  callLink: string | null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Where a local clock time falls on the window, 0–100, clamped. */
export function windowPercent(d: Date): number {
  const hours = d.getHours() + d.getMinutes() / 60
  const at = ((hours - DAY_START) / (DAY_END - DAY_START)) * 100
  return Math.min(100, Math.max(0, at))
}

/** The now label: `Now · 11:40`. */
export function nowLabel(d: Date): string {
  return `Now · ${formatTime(d)}`
}

/**
 * The browser's clock, read after mount and once a minute. Null on the
 * server and on the first client render, so hydration never compares two
 * clocks.
 */
export function useNow(): Date | null {
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

/** One meeting's ink block: its time and title on hover, the window on click. */
function Block({
  meeting,
  from,
  to,
  onOpen,
}: {
  meeting: DayStripMeeting
  from: number
  to: number
  onOpen: (id: string) => void
}) {
  const span = `${formatTime(meeting.startsAt)}–${formatTime(meeting.endsAt)}`
  return (
    <>
      <span
        data-meeting
        aria-hidden
        className="pointer-events-none absolute top-1.5 max-w-40 truncate mono text-field text-foreground"
        style={{ left: `${from}%` }}
      >
        {meeting.label}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-meeting-block
            aria-label={`${meeting.title} · ${span}`}
            onClick={() => onOpen(meeting.id)}
            className="focus-ring absolute top-5.5 z-10 h-4.5 bg-foreground outline-offset-1 hover:outline hover:outline-foreground"
            style={{ left: `${from}%`, width: `${to - from}%` }}
          />
        </TooltipTrigger>
        <TooltipContent>
          <span className="flex flex-col">
            <span className="mono">{span}</span>
            <span>
              {meeting.who === null
                ? meeting.title
                : `${meeting.title} · ${meeting.who}`}
            </span>
          </span>
        </TooltipContent>
      </Tooltip>
    </>
  )
}

/** A sans link or button in the head, graphite until hovered. */
const headLink =
  'focus-ring shrink-0 font-sans text-label text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground'

/**
 * The head's right: `‹ Today ›`, and away from today `Back to today` before
 * `‹ Wed 14 Oct ›`; then `All meetings ›`.
 */
function DayNav({
  day,
  today,
  onDay,
}: {
  day: string
  today: string
  onDay: (day: string) => void
}) {
  const step =
    'focus-ring px-1 text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground'
  return (
    <>
      {day === today ? null : (
        <button type="button" className={headLink} onClick={() => onDay(today)}>
          Back to today
        </button>
      )}
      <span role="group" aria-label="Day" className="flex items-baseline">
        <button
          type="button"
          aria-label="Previous day"
          className={step}
          onClick={() => onDay(shiftDay(day, -1))}
        >
          ‹
        </button>
        <span data-day className="px-1 text-foreground">
          {dayLabel(day, today)}
        </span>
        <button
          type="button"
          aria-label="Next day"
          className={step}
          onClick={() => onDay(shiftDay(day, 1))}
        >
          ›
        </button>
      </span>
      <Link to="/meetings" className={headLink}>
        All meetings ›
      </Link>
    </>
  )
}

/**
 * The working hours of the day Meetings shows, 08–20, as a card on the
 * ground under a head that holds the day.
 * - The head: `Meetings`, the day's count (none while read, failed or
 *   empty) and, on today only, `next in 2h 20m`; at its right `Join ↗` while
 *   a call is live or about to start (`stripHead`), then the day nav.
 * - Ink blocks for the day's meetings, labelled, each opening its window.
 * - Today dithers the elapsed part up to a pine now-dot with `Now · hh:mm`;
 *   a past day is dithered whole with no dot; a future day has no dither.
 * - Dither cells stay 2px: the svg has no viewBox, so its user units are pixels.
 * - Everything the clock decides waits for `useNow`, so the server and the
 *   first client render agree, and moves with it once a minute.
 */
export function DayStrip({
  day,
  today,
  onDay,
  count,
  meetings,
  onOpen,
}: {
  day: string
  today: string
  onDay: (day: string) => void
  /** Every meeting that day, cancelled ones too; null when none is shown. */
  count: number | null
  /** The day's meetings in start order, cancelled ones left out. */
  meetings: ReadonlyArray<DayStripMeeting>
  onOpen: (id: string) => void
}) {
  const clock = useNow()
  const pattern = useId()
  const tense = dayTense(day, today)
  const now = tense === 'today' ? clock : null
  const at = now === null ? null : windowPercent(now)
  const dithered = tense === 'past' ? 100 : (at ?? 0)
  const head = stripHead(meetings, now)
  return (
    <section
      aria-label="Day strip"
      data-day-strip={tense}
      className="flex shrink-0 flex-col card"
    >
      <div className="flex h-8 shrink-0 items-center justify-between gap-4 border-b border-rule px-(--inset)">
        <h2 className="min-w-0 truncate text-ui text-foreground">
          Meetings
          {count === null ? null : (
            <>
              {' '}
              <span
                data-strip-count
                className="tabular mono text-micro text-graphite"
              >
                {count}
              </span>
            </>
          )}
          {head.next === null ? null : (
            <span data-next className="text-label text-graphite">
              {` · next in ${head.next}`}
            </span>
          )}
        </h2>
        <div className="flex shrink-0 items-center gap-4 text-ui">
          {head.join === null ? null : (
            <a
              data-join
              href={head.join}
              target="_blank"
              rel="noreferrer"
              className="focus-ring text-ui text-foreground underline"
            >
              Join ↗
            </a>
          )}
          <DayNav day={day} today={today} onDay={onDay} />
        </div>
      </div>
      <div className="h-16 px-(--inset)">
        <div className="relative h-full">
          {meetings.map((m) => {
            const from = windowPercent(new Date(m.startsAt))
            const to = windowPercent(new Date(m.endsAt))
            if (to <= from) return null
            return (
              <Block
                key={m.id}
                meeting={m}
                from={from}
                to={to}
                onOpen={onOpen}
              />
            )
          })}
          <svg
            aria-hidden
            width="100%"
            height="18"
            className="pointer-events-none absolute inset-x-0 top-5.5"
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
            {dithered === 0 ? null : (
              <rect
                data-elapsed
                x="0"
                y="0"
                width={`${dithered}%`}
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
                className="absolute top-6.75 z-10 size-2 -translate-x-1/2 bg-primary"
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
    </section>
  )
}
