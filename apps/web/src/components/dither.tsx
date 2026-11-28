/**
 * Texture — the Dither Rule. One bit, pine or ink, never under text, and
 * animated only for a working state (`Twinkle`). Allowed in empty states,
 * chart fills, fallback marks, thumbnails and loading. Cells are 2px; a 4×4
 * Bayer matrix decides which cells a given density fills, so two blocks of
 * the same density are identical and nothing shimmers.
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
 * - The stylesheet's `shadow-dither` utility carries this string verbatim; a
 *   test fails when they drift.
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
