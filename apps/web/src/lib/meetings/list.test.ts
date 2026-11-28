import { describe, expect, it } from 'vitest'
import { isoDay } from './day'
import {
  byDay,
  defaultOpen,
  LATER_SHOWN,
  laterDay,
  laterEnd,
  laterMonths,
  nextToday,
  rowClock,
  upcomingHorizon,
} from './list'
import type { ListedMeeting } from './list'

/**
 * The Meetings page's horizon, day groups, which meeting the pane opens and
 * an agenda row's clock.
 */

let n = 0
const aMeeting = (over: Partial<ListedMeeting> = {}): ListedMeeting => ({
  id: `m${++n}`,
  kind: 'meeting',
  title: 'Call',
  startsAt: '2026-10-13T09:00:00.000Z',
  endsAt: '2026-10-13T09:30:00.000Z',
  cancelled: false,
  people: [],
  record: null,
  callLink: false,
  mine: true,
  members: [],
  noteId: null,
  writeUp: 'none',
  summary: null,
  via: null,
  unwritten: false,
  ...over,
})

describe('the upcoming horizon', () => {
  it('ends this week and next: the local Monday after next, at midnight', () => {
    // Mon `2026-10-12` → Mon `2026-10-26`.
    const monday = upcomingHorizon(new Date(2026, 9, 12, 15, 0))
    expect(isoDay(monday)).toBe('2026-10-26')
    expect(monday.getHours()).toBe(0)
    // Sun `2026-10-18` is still this week → Mon `2026-10-26`.
    expect(isoDay(upcomingHorizon(new Date(2026, 9, 18, 23, 0)))).toBe(
      '2026-10-26',
    )
    // Wed `2026-10-14` → Mon `2026-10-26`.
    expect(isoDay(upcomingHorizon(new Date(2026, 9, 14, 8, 0)))).toBe(
      '2026-10-26',
    )
  })
})

describe('the day groups', () => {
  it('groups consecutive meetings under their local day', () => {
    const a = aMeeting({ startsAt: new Date(2026, 9, 13, 9).toISOString() })
    const b = aMeeting({ startsAt: new Date(2026, 9, 13, 14).toISOString() })
    const c = aMeeting({ startsAt: new Date(2026, 9, 15, 10).toISOString() })
    expect(byDay([a, b, c])).toEqual([
      { day: '2026-10-13', meetings: [a, b] },
      { day: '2026-10-15', meetings: [c] },
    ])
  })
})

describe('the meeting the pane opens when the address names none', () => {
  it('opens Upcoming’s next meeting that is not cancelled', () => {
    const struck = aMeeting({ cancelled: true })
    const next = aMeeting()
    expect(defaultOpen('upcoming', [struck, next, aMeeting()])).toBe(next.id)
  })

  it('opens Past’s first row, whatever it is', () => {
    const first = aMeeting({ unwritten: true })
    expect(defaultOpen('past', [first, aMeeting()])).toBe(first.id)
  })

  it('opens nothing for an empty list, or one of only cancelled meetings', () => {
    expect(defaultOpen('upcoming', [])).toBeNull()
    expect(defaultOpen('past', [])).toBeNull()
    expect(defaultOpen('upcoming', [aMeeting({ cancelled: true })])).toBeNull()
  })
})

describe('an agenda row’s clock', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 15, h, m)
  const now = at(11, 22)
  const live = aMeeting({
    startsAt: at(11, 0).toISOString(),
    endsAt: at(11, 34).toISOString(),
  })
  const soon = aMeeting({
    startsAt: at(11, 30).toISOString(),
    endsAt: at(12, 0).toISOString(),
  })
  const later = aMeeting({
    startsAt: at(17, 30).toISOString(),
    endsAt: at(18, 15).toISOString(),
  })
  const rows = [live, soon, later]

  it('reads `in 8m` for the next meeting today and `Now · 12m left` for the live one', () => {
    const next = nextToday(rows, now)
    expect(next).toBe(soon.id)
    expect(rowClock(soon, now, next)).toEqual({ kind: 'next', text: 'in 8m' })
    expect(rowClock(live, now, next)).toEqual({
      kind: 'live',
      text: 'Now · 12m left',
    })
    // The rest read their length.
    expect(rowClock(later, now, next)).toEqual({ kind: 'length', text: '45m' })
  })

  it('skips a cancelled meeting for next, and shows a cancelled row nothing', () => {
    const struck = aMeeting({
      startsAt: at(11, 25).toISOString(),
      endsAt: at(11, 55).toISOString(),
      cancelled: true,
    })
    const next = nextToday([live, struck, soon], now)
    expect(next).toBe(soon.id)
    expect(rowClock(struck, now, next)).toEqual({ kind: 'cancelled' })
  })

  it('is no one’s `in` once today is done: tomorrow’s first meeting reads its length', () => {
    const tomorrow = aMeeting({
      startsAt: new Date(2026, 9, 16, 9, 0).toISOString(),
      endsAt: new Date(2026, 9, 16, 10, 0).toISOString(),
    })
    const late = at(20, 0)
    expect(nextToday([tomorrow], late)).toBeNull()
    expect(rowClock(tomorrow, late, null)).toEqual({
      kind: 'length',
      text: '1h',
    })
  })
})

describe('the later months', () => {
  // Local noon, so no clock reads a different day or month.
  const on = (y: number, m: number, d: number) =>
    aMeeting({ startsAt: new Date(y, m - 1, d, 12).toISOString() })

  it('bands the meetings after the two weeks by month, with their counts, the fold reaching the last one', () => {
    const november = [on(2026, 11, 3), on(2026, 11, 5), on(2026, 11, 11)]
    const more = [on(2026, 11, 19), on(2026, 11, 24)]
    const december = [on(2026, 12, 1), on(2026, 12, 14)]
    const january = [on(2027, 1, 6)]
    const rows = [...november, ...more, ...december, ...january]
    const months = laterMonths(rows, '2026-10-15')

    expect(
      months.map((m) => ({ label: m.label, count: m.rows.length })),
    ).toEqual([
      { label: 'November', count: 5 },
      { label: 'December', count: 2 },
      { label: 'January 2027', count: 1 },
    ])
    // Three show, then `2 more in November`.
    expect(months[0].rows.slice(0, LATER_SHOWN)).toEqual(november)
    expect(months[0].rows.length - LATER_SHOWN).toBe(2)
    expect(laterEnd(rows, '2026-10-15')).toBe('to 6 Jan 2027')
    expect(laterEnd([], '2026-10-15')).toBeNull()
    expect(laterDay(november[0].startsAt)).toBe('Tue 3')
  })
})
