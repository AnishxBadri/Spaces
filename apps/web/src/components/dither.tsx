import { cn } from '#/lib/utils'

/**
 * Texture — the Dither Rule (Instrument, 2026-09-10). One bit, pine or ink,
 * never under text, never animated. Allowed in empty states, chart fills,
 * fallback marks, thumbnails and loading. Cells are 2px; a 4×4 Bayer matrix
 * decides which cells a given density fills, so two blocks of the same
 * density are identical and nothing shimmers.
 */

/** 4×4 Bayer thresholds, 0–15: fill a cell when its threshold < level. */
export const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

/** The 2px cells of an 8px tile filled at `level` of 16, as [x, y]. */
export function cellsFor(level: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if (BAYER[y][x] < level) out.push([x * 2, y * 2])
    }
  }
  return out
}

/** A popover's shadow: Bayer 8 of 16, offset 4px. */
export const SHADOW_LEVEL = 8
export const SHADOW_OFFSET = 4

/**
 * The `shadow-dither` border image as a CSS `url()`: the sheet's 1px ink
 * edge plus the dithered copy of its box offset down and right.
 * - Unsized on purpose: a border image with no intrinsic size is drawn at
 *   the border-image area, so cells stay 2px at any sheet size.
 * - styles.css carries this string verbatim; a test fails when they drift.
 */
export function ditherShadowUrl(ink: string): string {
  const cells = cellsFor(SHADOW_LEVEL)
    .map(([x, y]) => `<rect x='${x}' y='${y}' width='2' height='2'/>`)
    .join('')
  const o = SHADOW_OFFSET
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' shape-rendering='crispEdges' fill='${ink}'>` +
    `<defs><pattern id='d' width='8' height='8' patternUnits='userSpaceOnUse'>${cells}</pattern></defs>` +
    `<rect x='${o}' y='${o}' width='100%' height='100%' fill='url(#d)'/>` +
    `<rect x='-${o}' y='-${o}' width='100%' height='100%'/></svg>`
  return `url("data:image/svg+xml,${svg.replace(/[<>#%]/g, (c) => encodeURIComponent(c))}")`
}

/** An 8px tile pattern at one of sixteen densities. */
function DitherPattern({
  id,
  level,
  fill,
}: {
  id: string
  level: number
  fill: string
}) {
  return (
    <pattern
      id={id}
      width="8"
      height="8"
      patternUnits="userSpaceOnUse"
      shapeRendering="crispEdges"
    >
      {cellsFor(level).map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="2" height="2" fill={fill} />
      ))}
    </pattern>
  )
}

/**
 * The empty-state block: a pine density ramp falling away toward the
 * bottom, with a paper sheet set into it. 160×120 by default.
 */
export function DitherBlock({
  width = 160,
  height = 120,
  className,
}: {
  width?: number
  height?: number
  className?: string
}) {
  const bands = [16, 12, 9, 6, 4, 2]
  const bandH = height / bands.length
  const sheet = {
    x: Math.round(width * 0.125),
    y: Math.round(height * 0.33),
    w: Math.round(width * 0.75),
    h: Math.round(height * 0.5),
  }
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0', className)}
    >
      <defs>
        {bands.map((level, i) => (
          <DitherPattern
            key={level}
            id={`dither-ramp-${i}`}
            level={level}
            fill="var(--primary)"
          />
        ))}
      </defs>
      {bands.map((_, i) => (
        <rect
          key={i}
          x="0"
          y={Math.round(i * bandH)}
          width={width}
          height={Math.ceil(bandH)}
          fill={`url(#dither-ramp-${i})`}
        />
      ))}
      <rect
        x={sheet.x + 0.5}
        y={sheet.y + 0.5}
        width={sheet.w - 1}
        height={sheet.h - 1}
        fill="var(--paper)"
        stroke="var(--hairline)"
      />
      {[0.3, 0.5, 0.7].map((f, i) => (
        <rect
          key={f}
          x={sheet.x + 12}
          y={Math.round(sheet.y + sheet.h * f)}
          width={Math.round(sheet.w * (i === 2 ? 0.45 : 0.6))}
          height="1"
          fill="var(--rule)"
        />
      ))}
    </svg>
  )
}

/**
 * Loading — a density ramp, not a shimmer: dense on the left, sparse on the
 * right, ink. Static by design (the Dither Rule forbids animation); the
 * ramp itself says "filling in".
 */
export function DensityRamp({
  width = 240,
  height = 8,
  className,
}: {
  width?: number
  height?: number
  className?: string
}) {
  const bands = [16, 12, 8, 5, 3, 1]
  const bandW = width / bands.length
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0', className)}
    >
      <defs>
        {bands.map((level, i) => (
          <DitherPattern
            key={level}
            id={`density-ramp-${i}`}
            level={level}
            fill="var(--hairline)"
          />
        ))}
      </defs>
      {bands.map((_, i) => (
        <rect
          key={i}
          x={Math.round(i * bandW)}
          y="0"
          width={Math.ceil(bandW)}
          height={height}
          fill={`url(#density-ramp-${i})`}
        />
      ))}
    </svg>
  )
}
