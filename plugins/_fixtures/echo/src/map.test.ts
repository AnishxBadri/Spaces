import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toClaims } from './map.ts'

const payload: unknown = JSON.parse(
  readFileSync(
    new URL('../fixtures/organization.json', import.meta.url),
    'utf8',
  ),
)

describe('the enrich mapping', () => {
  it('turns a recorded organization payload into identity, receipt and fact claims', () => {
    const { identity, receipt, facts } = toClaims(
      JSON.parse(JSON.stringify(payload)),
    )
    const entityId = 'entity-from-resolve'
    const receiptId = 'receipt-from-store'
    expect({
      identity,
      receipt: receipt(entityId),
      facts: facts(entityId, receiptId),
    }).toMatchSnapshot()
  })

  it('claims nothing the payload does not say', () => {
    const { identity, facts } = toClaims({
      organization: { name: 'Bare Co' },
    })
    expect(identity).toEqual({ kind: 'company', name: 'Bare Co', keys: {} })
    expect(facts('e', 'r').values).toEqual({})
  })

  it('refuses a payload that is not an organization response', () => {
    expect(() => toClaims({ people: [] })).toThrow()
  })
})
