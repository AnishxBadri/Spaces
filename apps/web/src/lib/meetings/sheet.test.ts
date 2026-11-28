import { describe, expect, it } from 'vitest'
import type { MeetingRsvp } from '@spaces/db/schema/interactions'
import { REPLY } from './sheet'
import type { ReplyDraw } from './sheet'

/** Each stored reply as the rail draws it: its square and its word. */
describe('REPLY', () => {
  it('maps every stored reply to its square and word', () => {
    const drawn: ReadonlyArray<[MeetingRsvp, ReplyDraw]> = [
      ['accepted', { square: 'filled', word: 'Yes', struck: false }],
      ['tentative', { square: 'dithered', word: 'Maybe', struck: false }],
      ['needs_action', { square: 'hollow', word: 'No reply', struck: false }],
      ['declined', { square: 'hollow', word: 'Declined', struck: true }],
    ]
    for (const [rsvp, draw] of drawn) expect(REPLY[rsvp], rsvp).toEqual(draw)
    expect(Object.keys(REPLY).sort()).toEqual(drawn.map(([r]) => r).sort())
  })
})
