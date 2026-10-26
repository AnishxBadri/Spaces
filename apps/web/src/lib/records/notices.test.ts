import { describe, expect, it } from 'vitest'
import { duplicateOf, duplicateWords, parkedWords } from './notices'

/** The record notices band's words, from the reads behind them. */

const side = (
  id: string,
  name: string,
  domains: Array<string> = [],
  identityDomain: string | null = null,
) => ({ id, name, domains, identityDomain })

describe('a possible duplicate', () => {
  it('reads the other side of the pair, from either side', () => {
    const pair = {
      id: 'p1',
      reason: { name_similarity: 'flent' },
      a: side('a', 'Flent', ['flent.com']),
      b: side('b', 'Flent Inc', ['flent.com']),
    }
    expect(duplicateOf(pair, 'a')).toEqual({
      pairId: 'p1',
      otherId: 'b',
      otherName: 'Flent Inc',
      key: 'flent.com',
    })
    expect(duplicateOf(pair, 'b').otherName).toBe('Flent')
  })

  it('names a shared domain first, else the name the sweep matched', () => {
    const pair = {
      id: 'p1',
      reason: { name_similarity: 'flent' },
      a: side('a', 'Flent', ['flent.com']),
      b: side('b', 'Flent Inc', [], 'flent.io'),
    }
    expect(duplicateOf(pair, 'a').key).toBe('flent')
    expect(
      duplicateOf({ ...pair, b: side('b', 'Flent Inc', [], 'flent.com') }, 'a')
        .key,
    ).toBe('flent.com')
  })

  it('says Possibly the same as, with the key on both', () => {
    const d = { pairId: 'p', otherId: 'b', otherName: 'Flent Inc' }
    expect(duplicateWords({ ...d, key: 'flent.com' })).toBe(
      'Possibly the same as Flent Inc · flent.com on both',
    )
    expect(duplicateWords({ ...d, key: null })).toBe(
      'Possibly the same as Flent Inc',
    )
  })
})

describe('a parked enrichment', () => {
  it('names the source and the reset in UTC', () => {
    expect(
      parkedWords({ source: 'Apollo', resumesAt: '2026-10-27T00:00:00.000Z' }),
    ).toBe('Enrich parked · Apollo limit reached · runs at 00:00 UTC')
  })
})
