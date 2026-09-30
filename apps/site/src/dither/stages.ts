import { ORBIT, STAGES } from '../content/landing'
import type { FragmentName, Stage } from '../content/landing'
import { STACK } from '../content/stack'
import { clamp, noise, outside, ramp } from './plate'
import type { Plate } from './plate'

/**
 * Every plate the site draws, by name — the list the /dither/<name>.png
 * endpoint prints at build time and the components ask for by URL.
 *
 * - `<stage>` and `<stage>-b` for each landing stage (hero, research, screen,
 *   decide, own, closing): the second is the same field one step denser, and
 *   the stage swaps between the two (`breathe` in Scaled.astro).
 * - `orbit`, `orbit-b`: the two rings and the dark surround behind "How it
 *   fits together".
 * - `mat`, `mat-b`: the edge band around the architecture stack.
 * - `hem`: the band under the nav's hairline, dense at the top and gone by
 *   its ninth pixel. It does not breathe.
 */

/** A fragment's size, CSS pixels, when the capture has not been taken. */
const PENDING = { width: 640, height: 240 }

export const fragmentSize = (name: FragmentName) =>
  __FRAGMENTS__[name] ?? PENDING

const CORNERS = {
  tl: [0, 0],
  tr: [1, 0],
  bl: [0, 1],
  br: [1, 1],
} as const

/**
 * A stage's field: dots gather toward its corner, drift with a slow
 * three-octave noise, and thin out around every card, so each piece of the
 * product sits in its own light.
 */
function stageField(stage: Stage): Plate['field'] {
  const grain = noise(stage.seed)
  const [u, v] = CORNERS[stage.corner]
  const cx = u * stage.width
  const cy = v * stage.height
  const diagonal = Math.hypot(stage.width, stage.height)
  return (x, y) => {
    const toward = 1 - Math.hypot(x - cx, y - cy) / diagonal
    const g = (grain(x, y, 160) - 0.5) * 2
    const base = 0.06 + 1.05 * toward ** 2.2 + 0.42 * g
    const near = Math.min(Infinity, ...stage.clear.map((r) => outside(x, y, r)))
    const light = 0.06 + 0.94 * ramp(near, 0, 96)
    return clamp(base * light)
  }
}

/** A ring of tone `a` at radius `r0`, fading to nothing `w` either side. */
const ring = (r: number, r0: number, w: number, a: number) =>
  Math.max(0, a * (1 - Math.abs(r - r0) / w))

/**
 * The orbit: two rings under the AI and the plugin tiles, and a surround
 * that darkens past the outer ring toward the corners.
 */
const ORBIT_PLATE: Plate = {
  width: ORBIT.width,
  height: ORBIT.height,
  dot: 2,
  field: (x, y) => {
    const r = Math.hypot(x - ORBIT.width / 2, y - ORBIT.height / 2)
    const d =
      ring(r, 240, 20, 0.3) +
      ring(r, 370, 26, 0.24) +
      (r > 490 ? Math.min(0.5, ((r - 490) / 240) * 0.5) : 0)
    return d <= 0.004 ? 0 : clamp(d)
  },
}

/** The nav hem: half tone under the hairline, nothing by its foot. */
const HEM: Plate = {
  width: 1440,
  height: 9,
  dot: 2,
  field: (_x, y) => 0.5 * (1 - y / 9),
}

/** The mat's band: dense at the outer edge, gone 56px in. */
const BAND = 56
const MAT: Plate = {
  width: STACK.width,
  height: STACK.height,
  dot: 2,
  field: (x, y) => {
    const e = Math.min(x, y, STACK.width - x, STACK.height - y)
    if (e > BAND) return 0
    return clamp(0.42 * (1 - e / BAND) ** 1.6 + 0.02)
  },
}

export const PLATES: ReadonlyMap<string, { plate: Plate; lift: number }> =
  (() => {
    const plates = new Map<string, { plate: Plate; lift: number }>()
    // One Bayer level: only the cells sitting exactly on the threshold turn.
    const step = 1 / 64
    const breathing = (name: string, plate: Plate) => {
      plates.set(name, { plate, lift: 0 })
      plates.set(`${name}-b`, { plate, lift: step })
    }
    for (const stage of STAGES) {
      breathing(stage.name, {
        width: stage.width,
        height: stage.height,
        field: stageField(stage),
      })
    }
    breathing(ORBIT.name, ORBIT_PLATE)
    breathing(STACK.name, MAT)
    plates.set('hem', { plate: HEM, lift: 0 })
    return plates
  })()

export const plateUrl = (name: string) => `/dither/${name}.png`
