import { describe, expect, it } from 'vitest'
import { parseDue } from './parse-due'

// 2026-08-07 is a Friday.
const TODAY = '2026-08-07'

describe('parseDue', () => {
  it('handles the chip words', () => {
    expect(parseDue('today', TODAY)).toBe('2026-08-07')
    expect(parseDue('Tomorrow', TODAY)).toBe('2026-08-08')
    expect(parseDue('next week', TODAY)).toBe('2026-08-14')
    expect(parseDue('next month', TODAY)).toBe('2026-09-07')
  })

  it('weekday names mean the coming instance', () => {
    expect(parseDue('tuesday', TODAY)).toBe('2026-08-11')
    expect(parseDue('next tuesday', TODAY)).toBe('2026-08-11')
    // Saying today's weekday means next week's, not today.
    expect(parseDue('friday', TODAY)).toBe('2026-08-14')
    expect(parseDue('Saturday', TODAY)).toBe('2026-08-08')
  })

  it('relative "in N" forms', () => {
    expect(parseDue('in 3 days', TODAY)).toBe('2026-08-10')
    expect(parseDue('in 1 day', TODAY)).toBe('2026-08-08')
    expect(parseDue('in 2 weeks', TODAY)).toBe('2026-08-21')
    expect(parseDue('in a week', TODAY)).toBe('2026-08-14')
    expect(parseDue('in 6 months', TODAY)).toBe('2027-02-07')
  })

  it('clamps month-end overflow', () => {
    expect(parseDue('in 1 month', '2026-01-31')).toBe('2026-02-28')
    expect(parseDue('in 1 month', '2028-01-31')).toBe('2028-02-29')
  })

  it('accepts bare ISO dates, rejects invalid ones', () => {
    expect(parseDue('2026-12-01', TODAY)).toBe('2026-12-01')
    expect(parseDue('2026-02-30', TODAY)).toBeNull()
  })

  it('returns null for garbage', () => {
    expect(parseDue('', TODAY)).toBeNull()
    expect(parseDue('whenever', TODAY)).toBeNull()
    expect(parseDue('in 0 days', TODAY)).toBeNull()
    expect(parseDue('in 999 weeks', TODAY)).toBeNull()
  })
})
