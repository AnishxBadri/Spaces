import { describe, expect, it } from 'vitest'
import { DASH, daysBetween, readoutDay, readoutRound } from './readout-format'

describe('readout days', () => {
  const today = '2026-10-05'

  it('prints the day in the current year and the year otherwise', () => {
    expect(readoutDay('2026-10-01', today)).toBe('1 Oct')
    expect(readoutDay('2025-11-04', today)).toBe('4 Nov 2025')
  })

  it('prints a dash for no day', () => {
    expect(readoutDay(null, today)).toBe(DASH)
  })

  it('prints a past or a coming day with no age tail', () => {
    expect(readoutDay('2026-10-04', today)).toBe('4 Oct')
    expect(readoutDay('2026-10-31', today)).toBe('31 Oct')
    expect(readoutDay('2026-10-02', today)).toBe('2 Oct')
  })

  it('counts calendar days across a year end', () => {
    expect(daysBetween('2025-12-31', '2026-01-02')).toBe(2)
  })
})

describe('the round readout', () => {
  it('prints the size at the post-money, compact and never Intl compact', () => {
    expect(
      readoutRound({
        raised: 4_200_000,
        postMoney: 18_000_000,
        currency: 'USD',
      }),
    ).toBe('$4.2M @ $18M')
  })

  it('reads a dash with no round, and keeps the half it has', () => {
    expect(readoutRound(null)).toBe(DASH)
    expect(
      readoutRound({ raised: null, postMoney: null, currency: 'USD' }),
    ).toBe(DASH)
    expect(
      readoutRound({ raised: 4_200_000, postMoney: null, currency: 'USD' }),
    ).toBe('$4.2M')
    expect(
      readoutRound({ raised: null, postMoney: 18_000_000, currency: 'USD' }),
    ).toBe(`${DASH} @ $18M`)
  })
})
