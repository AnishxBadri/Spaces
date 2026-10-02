import { describe, expect, it } from 'vitest'
import { BADGE_COLORS, nextBadgeColor } from './colors'

describe('nextBadgeColor', () => {
  it('follows position when nothing is taken', () => {
    expect(nextBadgeColor(0)).toBe('slate')
    expect(nextBadgeColor(3)).toBe('violet')
  })

  it('skips a hue a sibling already wears', () => {
    // A deleted row left two options on blue and indigo; the next is index 2.
    expect(nextBadgeColor(2, undefined, ['blue', 'indigo'])).toBe('violet')
    expect(nextBadgeColor(1, undefined, ['blue', 'indigo'])).toBe('violet')
  })

  it('seeds a status group once, then moves on', () => {
    expect(nextBadgeColor(0, 'active')).toBe('blue')
    expect(nextBadgeColor(1, 'active', ['blue'])).toBe('indigo')
    expect(nextBadgeColor(1, 'active', ['blue', 'indigo'])).toBe('violet')
  })

  it('falls back to the seed or position once all twelve are taken', () => {
    expect(nextBadgeColor(5, 'active', BADGE_COLORS)).toBe('blue')
    expect(nextBadgeColor(13, undefined, BADGE_COLORS)).toBe('blue')
  })
})
