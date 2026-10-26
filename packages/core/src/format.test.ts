import { describe, expect, it } from 'vitest'
import {
  dayKey,
  daysBetween,
  formatAge,
  formatDay,
  formatDue,
  formatFullDay,
  formatTime,
  formatWeekday,
  formatWeekdayHead,
  formatWhen,
  weekdayOf,
} from './format'

// Instants are built in the local clock so the suite reads the same in any zone.
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min)

describe('formatDay', () => {
  it('prints the day and month in the current year', () => {
    expect(formatDay('2026-10-13', '2026-10-26')).toBe('13 Oct')
    expect(formatDay(at(2026, 1, 4, 23, 59), '2026-10-26')).toBe('4 Jan')
  })

  it('adds the year in any other year, either side of the boundary', () => {
    expect(formatDay('2024-10-04', '2026-10-26')).toBe('4 Oct 2024')
    expect(formatDay('2025-12-31', '2026-01-01')).toBe('31 Dec 2025')
    expect(formatDay('2026-01-01', '2025-12-31')).toBe('1 Jan 2026')
  })

  it('never shifts a bare day by the zone', () => {
    expect(formatDay('2026-03-01', '2026-03-01')).toBe('1 Mar')
  })

  it('prints nothing for a non-date', () => {
    expect(formatDay('not a date', '2026-10-26')).toBe('')
  })
})

describe('formatFullDay', () => {
  it('always carries the year', () => {
    expect(formatFullDay('2026-10-04')).toBe('4 Oct 2026')
  })
})

describe('formatWhen', () => {
  const now = at(2026, 10, 26, 15, 0)

  it('prints the time today, or Today in a readout', () => {
    expect(formatWhen(at(2026, 10, 26, 10, 42), now)).toBe('10:42')
    expect(formatWhen(at(2026, 10, 26, 10, 42), now, { readout: true })).toBe(
      'Today',
    )
    expect(formatWhen('2026-10-26', now)).toBe('Today')
  })

  it('prints the day before today and the full day in an older year', () => {
    expect(formatWhen(at(2026, 10, 25, 23, 59), now)).toBe('25 Oct')
    expect(formatWhen(at(2024, 10, 4, 9, 0), now)).toBe('4 Oct 2024')
  })

  it('takes an ISO string as well as a Date', () => {
    expect(formatWhen(at(2026, 10, 26, 9, 5).toISOString(), now)).toBe('09:05')
  })
})

describe('formatDue', () => {
  const today = '2026-10-26' // a Monday

  it('prints how overdue a passed day is', () => {
    expect(formatDue('2026-10-24', today)).toBe('−2d')
    expect(formatDue('2025-12-30', '2026-01-02')).toBe('−3d')
  })

  it('prints the weekday within seven days', () => {
    expect(formatDue('2026-10-26', today)).toBe('Mon')
    expect(formatDue('2026-10-30', today)).toBe('Fri')
    expect(formatDue('2026-11-01', today)).toBe('Sun')
  })

  it('prints the day from seven days on', () => {
    expect(formatDue('2026-11-02', today)).toBe('2 Nov')
    expect(formatDue('2027-01-14', today)).toBe('14 Jan 2027')
  })
})

describe('formatAge', () => {
  const now = at(2026, 10, 26, 9, 0)

  it('prints days under 30', () => {
    expect(formatAge(at(2026, 10, 26, 8, 0), now)).toBe('0d')
    expect(formatAge('2026-10-14', now)).toBe('12d')
    expect(formatAge('2026-09-27', now)).toBe('29d')
  })

  it('prints the day from 30 days on', () => {
    expect(formatAge('2026-09-26', now)).toBe('26 Sep')
    expect(formatAge('2025-10-26', now)).toBe('26 Oct 2025')
  })

  it('never prints a negative age', () => {
    expect(formatAge('2026-10-27', now)).toBe('0d')
  })
})

describe('weekdays', () => {
  it('prints the prose and band forms', () => {
    expect(weekdayOf('2026-10-15')).toBe('Thu')
    expect(formatWeekday('2026-10-15', '2026-10-26')).toBe('Thu 15 Oct')
    expect(formatWeekdayHead('2026-10-15', '2026-10-26')).toBe('THU 15 OCT')
    expect(formatWeekday('2025-10-15', '2026-10-26')).toBe('Wed 15 Oct 2025')
  })
})

describe('keys and spans', () => {
  it('keys an instant by its local day', () => {
    expect(dayKey(at(2026, 1, 4, 23, 59))).toBe('2026-01-04')
    expect(dayKey('2026-01-04')).toBe('2026-01-04')
    expect(dayKey('nope')).toBe('')
  })

  it('counts calendar days across a year', () => {
    expect(daysBetween('2025-12-31', '2026-01-02')).toBe(2)
    expect(daysBetween('2026-01-02', '2025-12-31')).toBe(-2)
  })

  it('prints the time of an instant only', () => {
    expect(formatTime(at(2026, 10, 26, 7, 3))).toBe('07:03')
    expect(formatTime('2026-10-26')).toBe('')
  })
})
