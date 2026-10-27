import { describe, expect, it } from 'vitest'
import { teamLine } from './team'
import type { TeamEntry } from './team'

const entry = (over: Partial<TeamEntry>): TeamEntry => ({
  id: 'a',
  verb: 'document.filed',
  at: '2026-10-15T11:02:00.000Z',
  actorName: 'Anika Rao',
  subjectName: 'Exponent',
  objectName: null,
  ...over,
})

describe('teamLine', () => {
  it('says who filed what on which record, with no verb code', () => {
    expect(teamLine(entry({ objectName: 'Q3 board deck.pdf' }))).toBe(
      'Anika Rao filed Q3 board deck.pdf on Exponent',
    )
    expect(teamLine(entry({}))).toBe('Anika Rao filed a file on Exponent')
  })

  it('reads a known verb in the past tense', () => {
    expect(teamLine(entry({ verb: 'mark.added' }))).toBe(
      'Anika Rao recorded a mark on Exponent',
    )
    expect(teamLine(entry({ verb: 'company.created' }))).toBe(
      'Anika Rao added Exponent',
    )
  })

  it('reads an unknown verb as its words', () => {
    expect(
      teamLine(entry({ verb: 'record.poked_at', subjectName: 'Fintech' })),
    ).toBe('Anika Rao poked at Fintech')
  })
})
