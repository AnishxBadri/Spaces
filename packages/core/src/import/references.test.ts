import { describe, expect, it } from 'vitest'
import { CORE_IDENTITY_KEYS } from '../attributes/registry'
import {
  cellIdentityKind,
  createKey,
  referenceKey,
  referenceReason,
  summarizeReferences,
} from './references'
import type { ReferenceColumn, ReferenceOutcome } from './references'

/**
 * SPA-168. What a reference cell reads as and what its outcome is called —
 * pure, no database.
 */

const companyColumn = (createMissing = false): ReferenceColumn => ({
  type: 'record',
  column: 0,
  attributeId: 'a-company',
  multi: false,
  required: false,
  createMissing,
  target: {
    objectId: 'o-companies',
    kind: 'company',
    singular: 'Company',
    plural: 'Companies',
    identityKeys: [...CORE_IDENTITY_KEYS],
    creator: 'resolveEntity',
  },
})

describe('the exact form', () => {
  it('collapses whitespace and case, and nothing else', () => {
    expect(referenceKey('  Acme\t  Labs ')).toBe('acme labs')
    // Legal suffixes are not stripped: Acme Inc is not Acme.
    expect(referenceKey('Acme Inc')).not.toBe(referenceKey('Acme'))
    expect(referenceKey('Acme, Inc.')).toBe('acme, inc.')
  })
})

describe('what a cell reads as', () => {
  const keys = CORE_IDENTITY_KEYS
  it('a single token with a registrable domain is a domain; a name is none', () => {
    expect(cellIdentityKind('ohmium.com', keys)).toBe('domain')
    expect(cellIdentityKind('https://www.ohmium.com/about', keys)).toBe(
      'domain',
    )
    expect(cellIdentityKind('Ohmium', keys)).toBeNull()
    expect(cellIdentityKind('Ohmium Ltd', keys)).toBeNull()
  })

  it('an address is an email, a LinkedIn URL is linkedin — never a domain', () => {
    expect(cellIdentityKind('jane@ohmium.com', keys)).toBe('email')
    expect(cellIdentityKind('https://linkedin.com/company/ohmium', keys)).toBe(
      'linkedin',
    )
  })

  it('offers only the keys the referenced object carries', () => {
    expect(cellIdentityKind('ohmium.com', [])).toBeNull()
    expect(cellIdentityKind('jane@ohmium.com', ['domain'])).toBeNull()
  })
})

describe('reasons', () => {
  it('names the object, both candidates, and the member rule', () => {
    const col = companyColumn()
    expect(referenceReason(col, { status: 'missing', identity: null })).toBe(
      'no such company',
    )
    expect(
      referenceReason(col, {
        status: 'ambiguous',
        names: ['Acme Inc', 'Acme Labs'],
      }),
    ).toBe('2 matches: Acme Inc, Acme Labs')
    expect(
      referenceReason(col, {
        status: 'ambiguous',
        names: ['A', 'B', 'C', 'D', 'E'],
      }),
    ).toBe('5 matches: A, B, C +2')
    const member: ReferenceColumn = {
      type: 'member',
      column: 1,
      attributeId: 'a-owner',
      required: false,
    }
    expect(referenceReason(member, { status: 'not-email' })).toBe(
      "use the member's email",
    )
    expect(referenceReason(member, { status: 'missing', identity: null })).toBe(
      'no such member',
    )
  })

  it('keys a create by object and exact name, or by the key the cell read as', () => {
    expect(createKey('o', ' NewCo ', null)).toBe('o|name:newco')
    expect(
      createKey('o', 'newco.io', { kind: 'domain', value: 'newco.io' }),
    ).toBe('o|domain:newco.io')
  })
})

describe('the mapping head count', () => {
  const outcomes = new Map<string, ReferenceOutcome>([
    ['ohmium', { status: 'found', entityId: 'e', name: 'Ohmium' }],
    ['acme', { status: 'ambiguous', names: ['Acme Inc', 'Acme Labs'] }],
    ['newco', { status: 'missing', identity: null }],
  ])
  const values = ['Ohmium', '', 'Acme', 'NewCo', 'ohmium']

  it('counts found of non-blank, and says why the rest were not', () => {
    const out = summarizeReferences(companyColumn(), values, outcomes)
    expect(out.found).toBe(2)
    expect(out.total).toBe(4)
    expect(out.failures).toEqual([
      {
        row: 2,
        raw: 'Acme',
        reason: '"Acme" · 2 matches: Acme Inc, Acme Labs',
      },
      { row: 3, raw: 'NewCo', reason: '"NewCo" · no such company' },
    ])
  })

  it('a miss on a create-missing column is a planned create, not a failure', () => {
    const out = summarizeReferences(companyColumn(true), values, outcomes)
    expect(out.failures.map((f) => f.raw)).toEqual(['Acme'])
  })
})
