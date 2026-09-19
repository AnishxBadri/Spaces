import { describe, expect, it } from 'vitest'

import { badgeClasses, badgeTint } from './badge.tsx'

/**
 * SPA-22. `@testing-library/react` is not a dependency of this package and the
 * suite runs `environment: 'node'` over `src/**\/*.test.ts`, so the contract is
 * asserted through the class-and-style helpers the primitive is built from
 * rather than through a render. Adding a DOM renderer to prove three class
 * strings would be a heavier dependency than the thing under test.
 */
describe('badgeClasses', () => {
  it('is square, mono 11 medium, 20px tall, 6px inset', () => {
    const c = badgeClasses({})
    for (const cls of [
      'flex',
      'h-5',
      'items-center',
      'px-1.5',
      'mono',
      'text-micro',
      'font-medium',
    ])
      expect(c.split(' ')).toContain(cls)
    // No radius class at all — squares, never pills (DESIGN.md §4).
    expect(c).not.toMatch(/rounded/)
  })

  it('carries no focus, hover or press treatment until it is a control', () => {
    expect(badgeClasses({})).not.toMatch(/focus-ring|hover:|active:/)
    const live = badgeClasses({ interactive: true })
    expect(live.split(' ')).toContain('focus-ring')
    expect(live).toMatch(/hover:opacity-80/)
    expect(live).toMatch(/active:opacity-70/)
    // The reticle is the only focus treatment — never a ring (DESIGN.md).
    expect(live).not.toMatch(/(?:^|\s)ring-|focus(?:-visible)?:ring/)
  })

  it('renders the archived treatment once: struck graphite on bone', () => {
    const c = badgeClasses({ archived: true })
    expect(c).toMatch(/bg-bone/)
    expect(c).toMatch(/text-graphite/)
    expect(c).toMatch(/line-through/)
    expect(c).toMatch(/font-normal/)
  })

  it('renders the unselected treatment as a dashed rule in graphite', () => {
    const c = badgeClasses({ unselected: true })
    expect(c).toMatch(/border-dashed/)
    expect(c).toMatch(/border-rule/)
    expect(c).toMatch(/text-graphite/)
    expect(c).not.toMatch(/line-through/)
  })

  it('lets the caller override a box class rather than repeat it', () => {
    // tailwind-merge resolves the conflict, so the board's 18px lane wins.
    const c = badgeClasses({ className: 'h-[1.125rem] min-w-0 truncate' })
    expect(c.split(' ')).not.toContain('h-5')
    expect(c.split(' ')).toContain('h-[1.125rem]')
  })
})

describe('badgeTint', () => {
  it('takes the option row, so a stored colour wins', () => {
    expect(badgeTint({ option: { color: 'emerald' }, index: 3 })).toEqual({
      backgroundColor: 'var(--badge-emerald)',
      color: 'var(--badge-emerald-ink)',
    })
  })

  it("falls back to the option's position, which is why surfaces agree", () => {
    // `optionColor`'s index fallback: an option with no stored colour lands on
    // the same hue wherever it is drawn, as long as its index is the same.
    const board = badgeTint({ option: {}, index: 1 })
    const today = badgeTint({ option: undefined, index: 1 })
    expect(board).toEqual(today)
    expect(board).toEqual({
      backgroundColor: 'var(--badge-blue)',
      color: 'var(--badge-blue-ink)',
    })
  })

  it('wraps the palette rather than running out of hues', () => {
    expect(badgeTint({ option: {}, index: 0 })).toEqual(
      badgeTint({ option: {}, index: 12 }),
    )
  })

  it('paints no hue when archived or unselected', () => {
    expect(
      badgeTint({ option: { color: 'rose' }, index: 0, archived: true }),
    ).toBeUndefined()
    expect(
      badgeTint({ option: { color: 'rose' }, index: 0, unselected: true }),
    ).toBeUndefined()
  })
})
