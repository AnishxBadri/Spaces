import { describe, expect, it } from 'vitest'

import { switchClasses } from './switch.tsx'

/** SPA-22. Asserted through the class helper — see `badge.test.ts` for why. */
describe('switchClasses', () => {
  it('draws a 24×14 square track with a 10px square knob', () => {
    const { track, knob } = switchClasses({ checked: false })
    expect(track.split(' ')).toContain('h-3.5') // 14px
    expect(track.split(' ')).toContain('w-6') // 24px
    expect(track.split(' ')).toContain('p-px') // 2px of padding, both edges
    expect(track).not.toMatch(/rounded/)
    expect(knob.split(' ')).toContain('size-2.5') // 10px
    expect(knob).not.toMatch(/rounded/)
  })

  it('names the state on the knob, not only on the position', () => {
    // The whole point of the contract: a reviewer holding a screenshot of one
    // switch, with no second switch to compare against, can say which it is.
    const off = switchClasses({ checked: false })
    const on = switchClasses({ checked: true })
    expect(off.knob).toMatch(/bg-graphite/)
    expect(on.knob).toMatch(/bg-primary/)
    expect(off.knob).not.toMatch(/bg-primary/)
    expect(on.knob).not.toMatch(/bg-graphite/)
  })

  it('moves the knob on transform, never on layout', () => {
    expect(switchClasses({ checked: false }).knob).toMatch(/translate-x-0/)
    expect(switchClasses({ checked: true }).knob).toMatch(/translate-x-2\.5/)
    for (const c of Object.values(switchClasses({ checked: true })))
      expect(c).not.toMatch(/\bml-|\bmr-|\bleft-|\bjustify-end\b/)
  })

  it('is a rule track on paper off and the pine wash on', () => {
    expect(switchClasses({ checked: false }).track).toMatch(
      /border-rule.*bg-paper/,
    )
    expect(switchClasses({ checked: true }).track).toMatch(
      /border-primary.*bg-selected/,
    )
  })

  it('carries focus and disabled states, the reticle only', () => {
    const { root } = switchClasses({ checked: false })
    expect(root.split(' ')).toContain('focus-ring')
    expect(root).toMatch(/hover:text-foreground/)
    expect(root).toMatch(/disabled:pointer-events-none/)
    expect(root).toMatch(/disabled:opacity-50/)
    expect(root).not.toMatch(/(?:^|\s)ring-|focus(?:-visible)?:ring/)
  })

  it('names every transition', () => {
    const c = switchClasses({ checked: false })
    expect(c.track).toMatch(/transition-colors/)
    expect(c.knob).toMatch(/transition-transform/)
    for (const s of Object.values(c)) expect(s).not.toMatch(/transition-all/)
  })
})
