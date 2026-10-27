import { describe, expect, it } from 'vitest'
import {
  dayLabel,
  dayTense,
  dayWindow,
  isUpcoming,
  nowIndex,
  shiftDay,
  stripLabel,
  waitFor,
  whoLine,
} from './day'
import type { TodayMeeting } from './day'

/** The Meetings section's local day, its nav word, the now-rule, the who lane and the strip's labels. */

describe('the local day', () => {
  it('steps across a month end and windows a day as [midnight, next midnight)', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31')
    const { from, to } = dayWindow('2026-10-13')
    expect(new Date(from).getDate()).toBe(13)
    expect(new Date(from).getHours()).toBe(0)
    expect(Date.parse(to) - Date.parse(from)).toBeGreaterThanOrEqual(
      23 * 3_600_000,
    )
  })

  it('names the day in the nav: Today, else the day', () => {
    expect(dayLabel('2026-10-13', '2026-10-13')).toBe('Today')
    expect(dayLabel('2026-10-14', '2026-10-13')).toBe('Wed 14 Oct')
    expect(dayLabel('2026-10-12', '2026-10-13')).toBe('Mon 12 Oct')
    expect(dayLabel('2025-10-20', '2026-10-13')).toBe('Mon 20 Oct 2025')
  })

  it('places a day before, on or after today', () => {
    expect(dayTense('2026-10-12', '2026-10-13')).toBe('past')
    expect(dayTense('2026-10-13', '2026-10-13')).toBe('today')
    expect(dayTense('2026-11-01', '2026-10-13')).toBe('future')
  })
})

describe('the row and the strip', () => {
  const meeting = (over: Partial<TodayMeeting> = {}): TodayMeeting => ({
    id: 'm',
    title: 'Intro',
    startsAt: '2026-10-13T09:00:00.000Z',
    endsAt: '2026-10-13T09:30:00.000Z',
    cancelled: false,
    participants: [],
    records: [],
    artifacts: [],
    noteId: null,
    external: [],
    ...over,
  })

  it('prints who outside the workspace, the first and how many more', () => {
    expect(whoLine([])).toBeNull()
    expect(whoLine(['Priya Raman'])).toBe('Priya Raman')
    expect(whoLine(['Priya Raman', 'raj@vayu.in'])).toBe('Priya Raman +1')
  })

  it('labels a block by its first record that is not a person, then who, then the title', () => {
    const vayu = { id: 'c', kind: 'company', name: 'Vayu', objectSlug: null }
    const priya = { id: 'p', kind: 'person', name: 'Priya', objectSlug: null }
    expect(stripLabel(meeting({ records: [priya, vayu] }))).toBe('Vayu')
    expect(stripLabel(meeting({ records: [priya], external: ['Raj'] }))).toBe(
      'Raj',
    )
    expect(stripLabel(meeting())).toBe('Intro')
    expect(stripLabel(meeting({ title: null }))).toBe('Meeting')
  })

  it('says the wait to the next meeting in hours and minutes', () => {
    expect(waitFor(45 * 60_000)).toBe('45m')
    expect(waitFor(2 * 3_600_000)).toBe('2h')
    expect(waitFor(140 * 60_000)).toBe('2h 20m')
    expect(waitFor(10_000)).toBe('1m')
  })
})

describe('the now-rule', () => {
  const at = (iso: string) => ({ startsAt: iso })
  it('falls above the first meeting still ahead, or after the last', () => {
    const now = new Date('2026-10-13T12:00:00.000Z')
    const day = [
      at('2026-10-13T09:00:00.000Z'),
      at('2026-10-13T14:00:00.000Z'),
      at('2026-10-13T16:00:00.000Z'),
    ]
    expect(nowIndex(day, now)).toBe(1)
    expect(nowIndex(day.slice(0, 1), now)).toBe(1)
    expect(isUpcoming(day[1], now)).toBe(true)
    expect(isUpcoming(day[0], now)).toBe(false)
  })
})
