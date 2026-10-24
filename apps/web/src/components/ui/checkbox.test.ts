import { describe, expect, it } from 'vitest'

import { checkboxClasses, radioClasses } from './checkbox.tsx'

/** Asserted through the class helper — see the badge test for why. */
describe('checkboxClasses', () => {
  it('is a 14px square, never a rounded native control', () => {
    const c = checkboxClasses({ checked: false }).split(' ')
    expect(c).toContain('size-3.5')
    expect(c).toContain('border')
    expect(checkboxClasses({ checked: false })).not.toMatch(/rounded/)
  })

  it('fills with pine when checked', () => {
    const on = checkboxClasses({ checked: true })
    expect(on).toMatch(/border-primary/)
    expect(on).toMatch(/bg-primary/)
    expect(on).toMatch(/text-primary-foreground/)
  })

  it('rests on paper and tints to bone on hover when unchecked', () => {
    const off = checkboxClasses({ checked: false })
    expect(off).toMatch(/border-hairline/)
    expect(off).toMatch(/bg-paper/)
    expect(off).toMatch(/hover:bg-bone/)
    expect(off).not.toMatch(/bg-primary/)
  })

  it('carries focus, press and disabled states, the reticle only', () => {
    const c = checkboxClasses({ checked: false })
    expect(c.split(' ')).toContain('focus-ring')
    expect(c).toMatch(/disabled:pointer-events-none/)
    expect(c).toMatch(/disabled:opacity-50/)
    expect(c).not.toMatch(/(?:^|\s)ring-|focus(?:-visible)?:ring/)
  })

  it('names its transition rather than animating everything', () => {
    const c = checkboxClasses({ checked: false })
    expect(c).toMatch(/transition-colors/)
    expect(c).not.toMatch(/transition-all/)
  })

  it('takes a caller class for placement without losing the box', () => {
    const c = checkboxClasses({ checked: false, className: 'mt-0.5' }).split(
      ' ',
    )
    expect(c).toContain('mt-0.5')
    expect(c).toContain('size-3.5')
  })
})

describe('radioClasses', () => {
  it('is the checkbox square, never a circle', () => {
    const c = radioClasses({ checked: false }).split(' ')
    expect(c).toContain('size-3.5')
    expect(c).toContain('border')
    expect(radioClasses({ checked: true })).not.toMatch(/rounded/)
  })

  it('stays on paper when chosen: a pine border, not a pine fill', () => {
    const on = radioClasses({ checked: true })
    expect(on).toMatch(/border-primary/)
    expect(on).toMatch(/bg-paper/)
    expect(on).not.toMatch(/bg-primary/)
  })
})
