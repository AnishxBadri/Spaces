import { describe, expect, it } from 'vitest'
import {
  DASH,
  daysBetween,
  readoutDay,
  readoutDayAgo,
  readoutDayUntil,
} from './readout-format'

describe('readout days', () => {
  const today = '2026-10-05'

  it('prints MM-DD in the current year and the full day otherwise', () => {
    expect(readoutDay('2026-10-01', today)).toBe('10-01')
    expect(readoutDay('2025-11-04', today)).toBe('2025-11-04')
  })

  it('prints a dash for no day', () => {
    expect(readoutDay(null, today)).toBe(DASH)
    expect(readoutDayAgo(null, today)).toBe(DASH)
    expect(readoutDayUntil(null, today)).toBe(DASH)
  })

  it('prints how long ago and how long until', () => {
    expect(readoutDayAgo('2026-10-04', today)).toBe('10-04 · 1d')
    expect(readoutDayUntil('2026-10-31', today)).toBe('10-31 · 26d')
    expect(readoutDayUntil('2026-10-02', today)).toBe('10-02 · −3d')
  })

  it('counts calendar days across a year end', () => {
    expect(daysBetween('2025-12-31', '2026-01-02')).toBe(2)
  })
})
