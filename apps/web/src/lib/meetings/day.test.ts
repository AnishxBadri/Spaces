import { describe, expect, it } from 'vitest'
import {
  artifactMarks,
  dayLabel,
  dayWindow,
  isUpcoming,
  nowIndex,
  shiftDay,
} from './day'

/** The Meetings section's local day, its nav word, the now-rule and the marks. */

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

  it('names the day in the nav', () => {
    expect(dayLabel('2026-10-13', '2026-10-13')).toBe('today')
    expect(dayLabel('2026-10-14', '2026-10-13')).toBe('tomorrow')
    expect(dayLabel('2026-10-12', '2026-10-13')).toBe('yesterday')
    expect(dayLabel('2026-10-20', '2026-10-13')).toBe('Tue 10-20')
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

describe('artifactMarks', () => {
  it('prints the transcript and the recording, never an attachment', () => {
    expect(artifactMarks(['recording_link', 'transcript', 'attachment'])).toBe(
      'transcript · recording',
    )
    expect(artifactMarks([])).toBe('')
  })
})
