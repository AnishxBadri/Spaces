import sharp from 'sharp'

/**
 * The dither plates: every textured surface on the page is one of these,
 * printed once at build time (src/pages/dither/[name].png.ts serves them)
 * and never at runtime. A plate is 1-bit: a dot or no dot. Tone is only dot
 * density, and density is only an 8×8 ordered (Bayer) threshold against a
 * field, so there is no alpha ramp and no grey anywhere in the file.
 *
 * Geometry: one image pixel is one CSS pixel, and the page draws the plate at
 * its natural size with `image-rendering: pixelated`, so a dot stays a hard
 * square at any device pixel ratio. Dots sit on a 3px cell: at most one in
 * nine pixels is ink, which keeps the darkest tone a light, open grey.
 */

/** Pixels per dot cell. */
export const CELL = 3

/** Graphite, the second text colour (site.css `--graphite`). */
const DOT = { r: 0x5c, g: 0x5b, b: 0x56 }

/** The 8×8 Bayer index matrix, 0–63, built by the usual recursion. */
const BAYER: ReadonlyArray<ReadonlyArray<number>> = (() => {
  let m = [[0]]
  while (m.length < 8) {
    const n = m.length
    const next: Array<Array<number>> = []
    for (let y = 0; y < n * 2; y++) {
      const row: Array<number> = []
      for (let x = 0; x < n * 2; x++) {
        const base = 4 * (m[y % n]?.[x % n] ?? 0)
        const quadrant = [0, 2, 3, 1][(y < n ? 0 : 2) + (x < n ? 0 : 1)] ?? 0
        row.push(base + quadrant)
      }
      next.push(row)
    }
    m = next
  }
  return m
})()

/** Deterministic lattice noise: value noise, smoothstepped, three octaves. */
export function noise(seed: number) {
  const hash = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263 + seed * 144269) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295
  }
  const smooth = (t: number) => t * t * (3 - 2 * t)
  const value = (x: number, y: number) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const sx = smooth(x - x0)
    const sy = smooth(y - y0)
    const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * sx
    const bottom =
      hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * sx
    return top + (bottom - top) * sy
  }
  /** 0–1 at a point measured in CSS pixels. `scale` is the base wavelength. */
  return (x: number, y: number, scale = 180) =>
    value(x / scale, y / scale) * 0.6 +
    value(x / (scale / 2), y / (scale / 2)) * 0.28 +
    value(x / (scale / 4), y / (scale / 4)) * 0.12
}

export type Field = (
  /** CSS pixels from the plate's left edge. */
  x: number,
  /** CSS pixels from the plate's top edge. */
  y: number,
) => number

export type Plate = {
  readonly width: number
  readonly height: number
  /** Density, 0 (paper) to 1 (a dot in every cell). */
  readonly field: Field
  /**
   * The dot's side in pixels, 1 by default. The orbit, the nav hem and the
   * architecture mat print a 2×2 dot on the same 3px cell, a darker tone
   * for the figures that carry a diagram rather than a screenshot.
   */
  readonly dot?: 1 | 2
}

/**
 * The threshold test for one cell: is there a dot? A 1px dot samples the
 * field at the cell's centre; a 2×2 dot at its own centre, one pixel in.
 */
function inked(field: Field, cx: number, cy: number, lift: number, dot: 1 | 2) {
  const at = dot === 1 ? CELL / 2 : 1
  const d = field(cx * CELL + at, cy * CELL + at)
  // Blank stays blank: the lift darkens tone, it never prints on paper.
  if (d <= 0) return false
  return (d + lift) * 64 > (BAYER[cy % 8]?.[cx % 8] ?? 0) + 0.5
}

/**
 * The plate as a 1-bit indexed PNG: palette [transparent, graphite], so the
 * surface underneath (bone on a panel, paper on a card) is the paper colour.
 * `lift` shifts every density by that much — the second frame of a panel's
 * breathing, one step denser, is the same field with a small lift.
 */
export async function printPlate(plate: Plate, lift = 0): Promise<Buffer> {
  const { width, height } = plate
  const dot = plate.dot ?? 1
  const rgba = Buffer.alloc(width * height * 4)
  const cols = Math.ceil(width / CELL)
  const rows = Math.ceil(height / CELL)
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!inked(plate.field, cx, cy, lift, dot)) continue
      // The dot is the cell's top-left pixel, or its top-left 2×2.
      for (let dy = 0; dy < dot; dy++) {
        for (let dx = 0; dx < dot; dx++) {
          const x = cx * CELL + dx
          const y = cy * CELL + dy
          if (x >= width || y >= height) continue
          const i = (y * width + x) * 4
          rgba[i] = DOT.r
          rgba[i + 1] = DOT.g
          rgba[i + 2] = DOT.b
          rgba[i + 3] = 255
        }
      }
    }
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({
      palette: true,
      // Two palette entries: libvips writes a 1-bit PNG on its own.
      colours: 2,
      dither: 0,
      effort: 10,
      compressionLevel: 9,
    })
    .toBuffer()
}

// ---- field shapes --------------------------------------------------------

export const clamp = (v: number) => Math.min(1, Math.max(0, v))

/** 0 at `a`, 1 at `b`, smoothstepped between. */
export const ramp = (v: number, a: number, b: number) => {
  const t = clamp((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/**
 * Distance in CSS pixels from (x, y) to the rectangle `r`, 0 inside it.
 * Fields use it to thin the dots to nothing under where the fragments sit.
 */
export const outside = (
  x: number,
  y: number,
  r: { x: number; y: number; w: number; h: number },
) => {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w))
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h))
  return Math.hypot(dx, dy)
}
