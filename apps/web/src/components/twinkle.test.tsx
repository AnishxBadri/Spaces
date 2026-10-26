import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BAYER } from './dither'
import { TWINKLE_LIT, TWINKLE_STEP_MS, Twinkle, twinkleDelay } from './twinkle'

/**
 * The Twinkle is the one animated dither and the only working state: six of
 * sixteen dots lit, the lit set walking the Bayer order every 150ms, still
 * under reduced motion. Nothing in the app spins.
 */

const css = readFileSync(
  fileURLToPath(new URL('../styles.css', import.meta.url)),
  'utf8',
)

/** Every dot of the lit layer, as the markup carries it. */
function litDots(html: string) {
  return [
    ...html.matchAll(
      /<rect data-rank="(\d+)" class="([^"]*)" x="(\d+)" y="(\d+)"[^>]*style="opacity:(\d);animation-delay:(-?\d+)ms"/g,
    ),
  ].map((m) => ({
    rank: Number(m[1]),
    className: m[2],
    x: Number(m[3]),
    y: Number(m[4]),
    opacity: Number(m[5]),
    delay: Number(m[6]),
  }))
}

describe('Twinkle', () => {
  const html = renderToStaticMarkup(<Twinkle />)
  const dots = litDots(html)

  it('is a 4×4 grid of 2px dots on 2px gaps in a 14px box', () => {
    expect(dots).toHaveLength(16)
    expect(html).toContain('width="14" height="14"')
    expect(new Set(dots.map((d) => d.x))).toEqual(new Set([0, 4, 8, 12]))
    expect(html).toMatch(/width="2" height="2"/)
  })

  it('fills a 29px empty pane exactly', () => {
    const big = litDots(renderToStaticMarkup(<Twinkle size={29} />))
    expect(Math.max(...big.map((d) => d.x)) + 5).toBe(29)
  })

  it('holds its first step still: six lit, ranks 0–5', () => {
    const lit = dots.filter((d) => d.opacity === 1).map((d) => d.rank)
    expect(lit.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5])
    expect(TWINKLE_LIT).toBe(6)
  })

  it('walks the Bayer order one rank every 150ms, six lit at every step', () => {
    expect(TWINKLE_STEP_MS).toBe(150)
    expect(dots.map((d) => d.delay)).toEqual(
      dots.map((d) => twinkleDelay(d.rank)),
    )
    for (let step = 0; step < 16; step++) {
      // A dot's place in its own 16-step loop; it is lit for the first six.
      const lit = BAYER.flat().filter(
        (rank) =>
          (step - twinkleDelay(rank) / TWINKLE_STEP_MS) % 16 < TWINKLE_LIT,
      )
      const want = Array.from(
        { length: TWINKLE_LIT },
        (_, i) => (step + i) % 16,
      )
      expect(
        lit.sort((a, b) => a - b),
        `step ${step}`,
      ).toEqual(want.sort((a, b) => a - b))
    }
  })

  it('drops its animation under reduced motion', () => {
    for (const d of dots) {
      expect(d.className.split(' ')).toContain('twinkle-dot')
      expect(d.className.split(' ')).toContain('motion-reduce:animate-none')
    }
  })

  it('loops 2.4s on opacity only, in steps', () => {
    expect(css).toContain('animation: twinkle 2400ms step-end infinite')
    const at = css.indexOf('@keyframes twinkle')
    const frames = css.slice(at, css.indexOf('@utility twinkle-dot'))
    expect([...frames.matchAll(/([a-z-]+):/g)].map((m) => m[1])).toEqual([
      'opacity',
      'opacity',
      'opacity',
    ])
  })

  it('is decoration unless it is given a label', () => {
    expect(html).toContain('aria-hidden="true"')
    const named = renderToStaticMarkup(<Twinkle label="Uploading" />)
    expect(named).toContain('role="img"')
    expect(named).toContain('aria-label="Uploading"')
  })
})

describe('the spinner', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url))
  function sources(dir: string): Array<string> {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      return /\.(tsx?|css)$/.test(entry.name) && !entry.name.includes('.test.')
        ? [path]
        : []
    })
  }

  it('never ships: no spin, no Loader2, anywhere in the app', () => {
    const spinning = sources(SRC).filter((path) =>
      /animate-spin|Loader2/.test(readFileSync(path, 'utf8')),
    )
    expect(spinning).toEqual([])
  })
})
