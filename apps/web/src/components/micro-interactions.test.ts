import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { rowWashClass } from './ledger-section.tsx'
import {
  REJECT_HOLD_MS,
  REJECT_LEAVE_MS,
  rejectPaneClass,
} from './record/record-parts.tsx'
import { keyHintClasses } from './ui/button.tsx'

/**
 * SPA-53 — the four specifics DESIGN.md §5 carried from the Micro-interactions
 * sheet as "proposed, not yet in code": the composer wash, the rejected cell's
 * crimson hold, the toast's 8px rise, and the pending button's dropped key
 * hint. Two of the four are class strings, asserted through their helpers the
 * way `switch.test.ts` does; two are CSS, asserted by reading styles.css the
 * way `design-tokens.test.ts` does.
 *
 * What the CSS half is really holding is the Compositor Rule and the
 * reduced-motion switch — neither is verifiable in a browser from a test
 * runner, and both are decidable from the stylesheet.
 */

const css = readFileSync(
  fileURLToPath(new URL('../styles.css', import.meta.url)),
  'utf8',
)

/** The text of the first `{…}` block opened by `head`, braces balanced. */
function block(head: string): string {
  const at = css.indexOf(head)
  expect(at, head).toBeGreaterThan(-1)
  let depth = 0
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) {
      return css.slice(css.indexOf('{', at) + 1, i)
    }
  }
  throw new Error(`unbalanced block: ${head}`)
}

/** Every property name declared in a chunk of CSS, `--custom` ones included. */
function properties(chunk: string): Array<string> {
  const code = chunk.replace(/\/\*[\s\S]*?\*\//g, '')
  // `[a-z-]+` already spells `--y`: a custom property is a property here.
  return [...code.matchAll(/(?:^|[{;])\s*([a-z-]+)\s*:/g)].map((m) => m[1])
}

describe('the composer wash (250ms, bone, opacity only)', () => {
  it('is worn only by a row the page says was born here', () => {
    expect(rowWashClass(true)).toBe('row-wash')
    expect(rowWashClass(false)).toBe('')
    expect(rowWashClass(undefined)).toBe('')
  })

  it('animates nothing but opacity', () => {
    expect(properties(block('@keyframes row-wash'))).toEqual([
      'opacity',
      'opacity',
    ])
  })

  it('fades a bone pane out over 250ms, once, behind the row', () => {
    const utility = block('@utility row-wash')
    expect(utility).toContain('animation: row-wash 250ms var(--ease-out-quart)')
    // `forwards` is what keeps the wash gone after it has played, and what
    // makes `prefers-reduced-motion` land on "no wash" rather than "stuck on".
    expect(utility).toContain('forwards')
    expect(utility).toContain('background: var(--bone)')
    expect(utility).toContain('z-index: -1')
    // The row itself takes `position: relative` and nothing else: any z-index
    // here would make a stacking context and drop the row's own content
    // behind the pane.
    expect(properties(utility.slice(0, utility.indexOf('&::before')))).toEqual([
      'position',
    ])
  })
})

describe('the rejected cell (crimson in place for 2s)', () => {
  it('holds for two seconds, the fade out included', () => {
    expect(REJECT_HOLD_MS).toBe(2000)
    expect(REJECT_LEAVE_MS).toBeLessThan(REJECT_HOLD_MS)
  })

  it('arrives at full strength — the snap back has nothing to fade in from', () => {
    expect(rejectPaneClass('hold')).toMatch(/\bopacity-100\b/)
    expect(rejectPaneClass('hold')).toMatch(/\bborder-destructive\b/)
  })

  it('leaves on opacity alone, on a named transition', () => {
    expect(rejectPaneClass('leaving')).toMatch(/\bopacity-0\b/)
    expect(rejectPaneClass('leaving')).toMatch(/\btransition-opacity\b/)
    expect(rejectPaneClass('leaving')).not.toMatch(/transition-all/)
  })

  it('is a pane over the cell, never a border on it — the No-Shift Rule', () => {
    // A border on the cell itself would move its content by a pixel.
    for (const phase of ['hold', 'leaving'] as const) {
      expect(rejectPaneClass(phase)).toMatch(/\babsolute\b/)
      expect(rejectPaneClass(phase)).toMatch(/\binset-0\b/)
      expect(rejectPaneClass(phase)).toMatch(/\bpointer-events-none\b/)
    }
  })
})

describe('the toast (rises 8px in, leaves faster than it arrived)', () => {
  const toast = css.slice(
    css.indexOf('[data-sonner-toaster] [data-sonner-toast] {'),
    css.indexOf('@layer base {'),
  )

  it('transitions transform and opacity and nothing else', () => {
    // sonner's own rule carries `height` and `box-shadow` too; naming exactly
    // two properties is what takes them back out. The Compositor Rule.
    const declared = [...toast.matchAll(/transition:([^;]+);/g)]
    expect(declared.length).toBeGreaterThan(0)
    for (const [, value] of declared) {
      expect(value).toContain('transform')
      expect(value).toContain('opacity')
      expect(value).not.toContain('height')
      expect(value).not.toContain('box-shadow')
      expect(value).not.toMatch(/\ball\b/)
    }
  })

  it('enters over 180ms and exits over 120ms', () => {
    expect(block('[data-sonner-toaster] [data-sonner-toast] {')).toContain(
      '180ms',
    )
    for (const head of [
      "[data-sonner-toast][data-removed='true'] {",
      "[data-sonner-toast][data-removed='true'][data-front='false'][data-swipe-out='false'][data-expanded='false'] {",
    ]) {
      const exit = block(head)
      expect(exit, head).toContain('120ms')
      expect(exit, head).not.toContain('180ms')
    }
  })

  it('travels 8px, on translateY, both ways', () => {
    expect(toast).toContain('--y: translateY(8px)')
    expect(toast).toContain('--y: translateY(-8px)')
    expect(toast).toContain('--y: translateY(calc(var(--lift) * -8px))')
    // …and rests where it belongs, or it would sit 8px off forever.
    expect(toast).toContain("[data-sonner-toast][data-mounted='true']")
    expect(toast).toContain('--y: translateY(0)')
  })

  it('sets every property through a token, never a literal ease', () => {
    expect(
      properties(toast).filter((p) => p !== '--y' && p !== 'transition'),
    ).toEqual([])
    expect(toast).not.toMatch(/cubic-bezier|\bease-in-out\b/)
  })
})

describe('the pending button (drops its key hint, keeps its width)', () => {
  it('drops the hint while the write is in flight and brings it back after', () => {
    expect(keyHintClasses(true)).toMatch(/\bopacity-0\b/)
    expect(keyHintClasses(false)).toMatch(/\bopacity-85\b/)
  })

  it('goes on opacity, so the hint never leaves the box it reserved', () => {
    // The No-Shift Rule: a hint that unmounted would let `Saving…` slide the
    // button's edge, and everything beside it with it.
    for (const pending of [true, false]) {
      expect(keyHintClasses(pending)).not.toMatch(/\bhidden\b/)
      expect(keyHintClasses(pending)).toMatch(/\btransition-opacity\b/)
      expect(keyHintClasses(pending)).not.toMatch(/transition-all/)
    }
  })

  it('stays mono at the micro step in both states', () => {
    for (const pending of [true, false]) {
      expect(keyHintClasses(pending).split(' ')).toContain('mono')
      expect(keyHintClasses(pending).split(' ')).toContain('text-micro')
    }
  })
})

describe('prefers-reduced-motion silences all four', () => {
  const reduce = block('@media (prefers-reduced-motion: reduce)')

  it('covers animation as well as transition, on the universal selector', () => {
    // The wash and the toast are animations and transitions respectively; the
    // crimson hold is a state with a transition off it. One switch, all four.
    expect(reduce).toContain('*,')
    expect(reduce).toContain('*::before')
    expect(reduce).toContain('*::after')
    expect(reduce).toContain('animation-duration: 0.01ms !important')
    expect(reduce).toContain('animation-iteration-count: 1 !important')
    expect(reduce).toContain('transition-duration: 0.01ms !important')
  })

  it('is important inside a layer, so nothing unlayered can outrank it', () => {
    // The toast rules have to be unlayered to beat sonner's runtime sheet.
    // Important-in-a-layer beats every unlayered declaration, which is the
    // only reason those rules cannot escape this switch.
    const base = css.slice(css.indexOf('@layer base {'))
    expect(base).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
