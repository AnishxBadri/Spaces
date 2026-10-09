import { useEffect, useId, useState } from 'react'
import { cellsFor } from '#/components/dither'

/** The hours the strip labels, every three. */
const LABELS = [0, 3, 6, 9, 12, 15, 18, 21]
/** Elapsed time's density: Bayer 6 of 16, ink. */
const ELAPSED_LEVEL = 6
const MINUTES_IN_DAY = 24 * 60

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

/**
 * Today's hours as a thin band under the head: the elapsed part dithered,
 * now a pine dot. (D79)
 * - Meetings draw as ink blocks once a calendar source exists; until then
 *   the band is hours only.
 * - Cells stay 2px: the svg has no viewBox, so its user units are pixels.
 */
export function DayStrip() {
  const now = useNow()
  const pattern = useId()
  const at =
    now === null
      ? null
      : ((now.getHours() * 60 + now.getMinutes()) / MINUTES_IN_DAY) * 100
  return (
    <div
      aria-hidden
      className="flex h-9 shrink-0 flex-col justify-center gap-1 border-b border-hairline px-8"
    >
      <div className="relative h-3">
        <svg width="100%" height="12" className="absolute inset-0">
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
          <rect x="0" y="0" width="100%" height="12" fill="var(--paper)" />
          {at === null ? null : (
            <rect
              x="0"
              y="0"
              width={`${at}%`}
              height="12"
              fill={`url(#${pattern})`}
            />
          )}
          {Array.from({ length: 25 }, (_, h) => (
            <rect
              key={h}
              x={`${(h / 24) * 100}%`}
              y={h % 3 === 0 ? 0 : 6}
              width="1"
              height={h % 3 === 0 ? 12 : 6}
              fill="var(--rule)"
            />
          ))}
        </svg>
        {at === null ? null : (
          <span
            data-now
            className="absolute top-0.5 size-2 -translate-x-1/2 bg-primary"
            style={{ left: `${at}%` }}
          />
        )}
      </div>
      <div className="relative h-3">
        {LABELS.map((h) => (
          <span
            key={h}
            className="absolute top-0 mono text-micro leading-3 text-graphite"
            style={{ left: `${(h / 24) * 100}%` }}
          >
            {String(h).padStart(2, '0')}
          </span>
        ))}
      </div>
    </div>
  )
}
