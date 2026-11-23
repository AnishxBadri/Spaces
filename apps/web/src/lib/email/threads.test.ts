import { describe, expect, it } from 'vitest'
import { draftLine, recipientsLine, threadDay } from './threads'

/**
 * The Email page's lanes: the day a row ends on (the time today, the
 * weekday this week, else the day), and a draft row's second line.
 */

/** Thu 15 Oct 2026, mid-morning. */
const NOW = new Date(2026, 9, 15, 11, 0).toISOString()
const at = (day: number, month = 9, year = 2026) =>
  new Date(year, month, day, 10, 42).toISOString()

describe('threadDay', () => {
  it('prints today’s time, this week’s weekday, then the day', () => {
    expect(threadDay(at(15), NOW)).toBe('10:42')
    expect(threadDay(at(13), NOW)).toBe('Tue')
    expect(threadDay(at(12), NOW)).toBe('Mon')
    expect(threadDay(at(9), NOW)).toBe('9 Oct')
    expect(threadDay(at(4, 9, 2025), NOW)).toBe('4 Oct 2025')
  })
})

describe('draftLine', () => {
  it('reads the mode, then the first recipient and a count', () => {
    expect(
      draftLine({
        mode: 'reply_all',
        to: [
          { email: 'arjun@lattice.example', name: 'Arjun Mehta' },
          { email: 'priya@exponent.example' },
          { email: 'dev@exponent.example' },
        ],
      }),
    ).toBe('Reply all · Arjun Mehta +2')
    expect(
      draftLine({ mode: 'reply', to: [{ email: 'sana@keystay.example' }] }),
    ).toBe('Reply · sana@keystay.example')
  })

  it('reads the mode alone with nobody to send to', () => {
    expect(draftLine({ mode: 'new', to: [] })).toBe('New email')
    expect(recipientsLine([])).toBeNull()
  })
})
