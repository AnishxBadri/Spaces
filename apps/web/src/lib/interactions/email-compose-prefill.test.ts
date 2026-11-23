import { describe, expect, it } from 'vitest'
import { prefillTo } from './email-compose-prefill'
import type { PrefillPerson } from './email-compose-prefill'

/**
 * To on a new email started from a record: the person on a person, the
 * person last emailed there on a company or a deal, empty otherwise.
 */

const person = (
  name: string,
  email: string | null,
  lastEmailAt: string | null,
): PrefillPerson => ({
  entityId: `p-${name}`,
  name,
  email,
  lastEmailAt,
})

const DEV = person('Dev Shah', 'dev@flent.example', '2026-11-10T09:00:00.000Z')
const PRIYA = person(
  'Priya Raman',
  'priya@flent.example',
  '2026-11-18T16:30:00.000Z',
)
const MEERA = person('Meera Nair', 'meera@flent.example', null)

describe('prefillTo', () => {
  it('fills a person with that person', () => {
    expect(prefillTo({ kind: 'person', person: DEV })).toEqual([
      { email: 'dev@flent.example', entityId: 'p-Dev Shah', name: 'Dev Shah' },
    ])
  })

  it('leaves a person with no address empty', () => {
    expect(
      prefillTo({ kind: 'person', person: person('Rohan', null, null) }),
    ).toEqual([])
  })

  it('fills a company with the person last emailed there', () => {
    expect(prefillTo({ kind: 'company', team: [DEV, MEERA, PRIYA] })).toEqual([
      {
        email: 'priya@flent.example',
        entityId: 'p-Priya Raman',
        name: 'Priya Raman',
      },
    ])
  })

  it('fills a deal with the person last emailed at its company', () => {
    expect(prefillTo({ kind: 'deal', team: [PRIYA, DEV] })).toEqual([
      {
        email: 'priya@flent.example',
        entityId: 'p-Priya Raman',
        name: 'Priya Raman',
      },
    ])
  })

  it('skips a more recent contact with no address', () => {
    const late = person('Kavya', null, '2026-11-20T09:00:00.000Z')
    expect(prefillTo({ kind: 'company', team: [late, DEV] })).toEqual([
      { email: 'dev@flent.example', entityId: 'p-Dev Shah', name: 'Dev Shah' },
    ])
  })

  it('leaves To empty when nobody there was ever emailed, on a deal with no company, and elsewhere', () => {
    expect(prefillTo({ kind: 'company', team: [MEERA] })).toEqual([])
    expect(prefillTo({ kind: 'deal', team: [] })).toEqual([])
    expect(prefillTo({ kind: 'other' })).toEqual([])
  })
})
