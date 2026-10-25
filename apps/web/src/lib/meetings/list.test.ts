import { describe, expect, it } from 'vitest'
import { isoDay } from './day'
import {
  byDay,
  dayHead,
  filterCounts,
  filterMeetings,
  pastWhen,
  upcomingHorizon,
  writeUpWord,
} from './list'
import type { ListedMeeting } from './list'

/** The Meetings page's filters, counts, horizon, day groups and state words. */

let n = 0
const aMeeting = (over: Partial<ListedMeeting> = {}): ListedMeeting => ({
  id: `m${++n}`,
  title: 'Call',
  startsAt: '2026-10-13T09:00:00.000Z',
  endsAt: '2026-10-13T09:30:00.000Z',
  cancelled: false,
  participants: [],
  records: [],
  artifacts: [],
  noteId: null,
  mine: false,
  myRsvp: null,
  writeUp: 'none',
  via: null,
  ...over,
})

describe('the filters', () => {
  const up = aMeeting({ mine: true })
  const upOther = aMeeting()
  const unwritten = aMeeting()
  const cancelled = aMeeting({ cancelled: true })
  const written = aMeeting({ writeUp: 'written', noteId: 'n1', mine: true })
  const hidden = aMeeting({ writeUp: 'private', noteId: 'n2' })
  const list = {
    upcoming: [up, upOther],
    past: [unwritten, cancelled, written, hidden],
  }

  it('narrows the list, order kept', () => {
    expect(filterMeetings(list, 'all')).toEqual(list)
    expect(filterMeetings(list, 'upcoming')).toEqual({
      upcoming: [up, upOther],
      past: [],
    })
    expect(filterMeetings(list, 'past')).toEqual({
      upcoming: [],
      past: list.past,
    })
    // Past rows with nothing written only; a cancelled one needs none.
    expect(filterMeetings(list, 'unwritten')).toEqual({
      upcoming: [],
      past: [unwritten],
    })
    expect(filterMeetings(list, 'mine')).toEqual({
      upcoming: [up],
      past: [written],
    })
  })

  it('counts each tab from the same narrowing', () => {
    expect(filterCounts(list)).toEqual({
      all: 6,
      upcoming: 2,
      past: 4,
      unwritten: 1,
      mine: 2,
    })
  })
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

describe('a day head', () => {
  it('names today and tomorrow beside the date, and dates the rest', () => {
    expect(dayHead('2026-10-12', '2026-10-12')).toBe('Today · Mon 10-12')
    expect(dayHead('2026-10-13', '2026-10-12')).toBe('Tomorrow · Tue 10-13')
    expect(dayHead('2026-10-20', '2026-10-12')).toBe('Tue 10-20')
  })
})

describe('a past row', () => {
  it('prints its date and time in the reader’s clock', () => {
    expect(pastWhen(new Date(2026, 9, 8, 9, 30).toISOString())).toBe(
      '10-08 09:30',
    )
  })

  it('ends on its write-up state', () => {
    expect(writeUpWord(aMeeting())).toBe('no write-up')
    expect(writeUpWord(aMeeting({ writeUp: 'written' }))).toBe('written')
    expect(writeUpWord(aMeeting({ writeUp: 'written', via: 'Granola' }))).toBe(
      'via Granola',
    )
    expect(writeUpWord(aMeeting({ writeUp: 'private' }))).toBe('private')
    expect(writeUpWord(aMeeting({ cancelled: true }))).toBe('cancelled')
  })
})
