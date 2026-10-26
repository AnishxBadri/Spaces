import { BAYER } from './dither'
import { cn } from '#/lib/utils'

/** Dots lit at any one step, of sixteen. */
export const TWINKLE_LIT = 6
/** One step of the lit set; sixteen of them make the 2.4s loop. */
export const TWINKLE_STEP_MS = 150

/** The two sizes: a row's mark slot, and an empty pane. */
export type TwinkleSize = 14 | 29

/** Dot and gap, px, per size: the 4×4 grid fills the box exactly. */
const GRID: Record<TwinkleSize, { dot: number; gap: number }> = {
  14: { dot: 2, gap: 2 },
  29: { dot: 5, gap: 3 },
}

/** Lit dots and the rest: ink on rule on paper, paper on graphite in a toast. */
const TONE = {
  ink: { on: 'var(--hairline)', off: 'var(--rule)' },
  paper: { on: 'var(--paper)', off: 'var(--graphite)' },
}

/**
 * The animation delay that puts a dot of Bayer `rank` in phase: at step k the
 * lit set is ranks k…k+5 (mod 16), so a dot is lit from step rank−5 to rank.
 * Negative, so the loop is already running when it mounts.
 */
export function twinkleDelay(rank: number): number {
  const steps = (TWINKLE_LIT - 1 - rank + 16) % 16
  return 0 - steps * TWINKLE_STEP_MS
}

/**
 * The working state — the one animated dither, and the only thing that ever
 * stands for a spinner. A 4×4 grid, 1-bit, six dots lit, the lit set walking
 * the Bayer order every 150ms. Under reduced motion it holds still on its
 * first step, which is also what it renders before the stylesheet loads.
 */
export function Twinkle({
  size = 14,
  tone = 'ink',
  label,
  className,
}: {
  size?: TwinkleSize
  tone?: keyof typeof TONE
  /** Read out in place of the grid; omitted, the grid is decoration. */
  label?: string
  className?: string
}) {
  const { dot, gap } = GRID[size]
  const colour = TONE[tone]
  const cells = BAYER.flatMap((row, y) =>
    row.map((rank, x) => ({ rank, x: x * (dot + gap), y: y * (dot + gap) })),
  )
  return (
    <svg
      data-twinkle
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn('shrink-0', className)}
      {...(label === undefined
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': label })}
    >
      {cells.map(({ rank, x, y }) => (
        <rect
          key={`off-${rank}`}
          x={x}
          y={y}
          width={dot}
          height={dot}
          fill={colour.off}
        />
      ))}
      {cells.map(({ rank, x, y }) => (
        <rect
          key={`on-${rank}`}
          data-rank={rank}
          className="twinkle-dot motion-reduce:animate-none"
          x={x}
          y={y}
          width={dot}
          height={dot}
          fill={colour.on}
          style={{
            opacity: rank < TWINKLE_LIT ? 1 : 0,
            animationDelay: `${twinkleDelay(rank)}ms`,
          }}
        />
      ))}
    </svg>
  )
}
