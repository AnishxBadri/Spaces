import { describe, expect, it } from 'vitest'
import { mapEvent } from './events.ts'
import type { CalendarEvent } from './events.ts'

/**
 * Which events become claims: the calendar's own kinds of block are skipped
 * here, before the host is asked, and the place travels with the claim.
 */
const CONNECTED = '2026-10-10T09:00:00.000Z'

const meeting: CalendarEvent = {
  id: 'flent-partner',
  iCalUID: 'flent-partner@google.com',
  status: 'confirmed',
  summary: 'Flent — partner meeting',
  start: { dateTime: '2026-10-20T08:30:00Z' },
  end: { dateTime: '2026-10-20T09:30:00Z' },
  organizer: { email: 'anish@fund.example' },
  attendees: [
    { email: 'anish@fund.example', self: true, responseStatus: 'accepted' },
    { email: 'riya@flent.example', responseStatus: 'accepted' },
  ],
}

describe('mapEvent: what is never a meeting', () => {
  it('skips an all-day event, which has a date and no time', () => {
    const mapped = mapEvent(
      {
        ...meeting,
        start: { date: '2026-10-20' },
        end: { date: '2026-10-21' },
      },
      CONNECTED,
    )
    expect(mapped).toEqual({ _tag: 'skip', reason: 'all-day' })
  })

  it.each(['outOfOffice', 'focusTime', 'workingLocation', 'birthday'])(
    'skips a %s event',
    (eventType) => {
      expect(mapEvent({ ...meeting, eventType }, CONNECTED)).toEqual({
        _tag: 'skip',
        reason: 'event-type',
      })
    },
  )

  it('skips an event its owner marked private', () => {
    expect(mapEvent({ ...meeting, visibility: 'private' }, CONNECTED)).toEqual({
      _tag: 'skip',
      reason: 'private',
    })
    expect(
      mapEvent({ ...meeting, visibility: 'confidential' }, CONNECTED),
    ).toEqual({ _tag: 'skip', reason: 'private' })
  })

  it('sends an ordinary event, and a cancelled private one to mark what is held', () => {
    expect(
      mapEvent(
        { ...meeting, eventType: 'default', visibility: 'public' },
        CONNECTED,
      ),
    ).toMatchObject({ _tag: 'claim', claim: { _tag: 'meeting' } })
    expect(
      mapEvent(
        { ...meeting, status: 'cancelled', visibility: 'private' },
        CONNECTED,
      ),
    ).toMatchObject({
      _tag: 'claim',
      claim: { _tag: 'meeting', status: 'cancelled' },
    })
  })
})

describe('mapEvent: the place', () => {
  it('reads the location onto the claim, and nothing from the description', () => {
    const mapped = mapEvent(
      {
        ...meeting,
        location: '  Flent, 4th floor\n12th Main Road, Indiranagar, Bengaluru ',
        ...{ description: 'Door code 4471' },
      },
      CONNECTED,
    )
    if (mapped._tag !== 'claim') throw new Error('expected a claim')
    expect(mapped.claim).toMatchObject({
      location: 'Flent, 4th floor\n12th Main Road, Indiranagar, Bengaluru',
    })
    expect(JSON.stringify(mapped.claim)).not.toContain('4471')
  })

  it('sends no location for a blank one', () => {
    const mapped = mapEvent({ ...meeting, location: '   ' }, CONNECTED)
    if (mapped._tag !== 'claim') throw new Error('expected a claim')
    expect('location' in mapped.claim).toBe(false)
  })
})
