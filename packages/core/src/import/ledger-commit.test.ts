import { describe, expect, it } from 'vitest'
import {
  ledgerOutcomeParts,
  ledgerVoidLine,
  missingRateLine,
  missingRates,
} from './ledger-commit'
import { commitOutcomeOf } from './commit'
import type { LedgerRowPlan } from '@spaces/db/schema/import'

/** SPA-171: the ledger receipt's pure half. */

const plan = (committed?: LedgerRowPlan['ledger']['committed']) => {
  const p: LedgerRowPlan = {
    verdict: 'create',
    creator: 'resolveEntity',
    name: 'Pixxel',
    patch: {},
    identity: {},
    errors: [],
    skippedCells: [],
    kind: 'ledger',
    ledger: {
      company: 'ref:pixxel',
      birthsHolding: true,
      events: {
        round: {
          date: '2023-03-15',
          kind: 'Seed',
          raised: 5000000,
          currency: 'USD',
          preMoney: 20000000,
          postMoney: null,
          pricePerShare: null,
          sharesOutstanding: null,
        },
        investment: {
          date: '2023-03-15',
          amount: 50000,
          currency: 'USD',
          instrument: 'priced',
          shares: null,
          cap: null,
          discount: null,
          vehicle: 'Fund I',
          roundRow: null,
        },
        mark: {
          date: '2025-12-31',
          fairValue: 120000,
          currency: 'USD',
          basis: 'manual',
        },
      },
      needs: [],
      ...(committed ? { committed } : {}),
    },
  }
  return p
}

describe('the outcome lane', () => {
  it('names the events a committed row appended', () => {
    const p = plan({
      holdingId: 'h-1',
      holdingBorn: true,
      roundId: 'r-1',
      investmentId: 'i-1',
      markId: 'm-1',
    })
    expect(ledgerOutcomeParts(p)).toEqual([
      'holding born',
      'round Seed',
      'investment $50,000',
      'mark $120,000',
    ])
    expect(commitOutcomeOf({ plan: p, entityId: 'e-1', error: null })).toEqual({
      kind: 'appended',
      entityId: 'e-1',
      holdingId: 'h-1',
      parts: [
        'holding born',
        'round Seed',
        'investment $50,000',
        'mark $120,000',
      ],
    })
  })

  it('says which events matched an existing row, and a row not yet reached is pending', () => {
    const p = plan({
      holdingId: 'h-1',
      holdingBorn: false,
      roundId: 'r-1',
      investmentId: 'i-1',
      markId: 'm-1',
      reused: ['round', 'investment'],
    })
    expect(ledgerOutcomeParts(p)).toEqual([
      'round Seed (existing)',
      'investment $50,000 (existing)',
      'mark $120,000',
    ])
    expect(
      commitOutcomeOf({ plan: plan(), entityId: null, error: null }),
    ).toEqual({ kind: 'pending' })
    expect(
      commitOutcomeOf({
        plan: plan(),
        entityId: null,
        error: 'Pixxel · value too long',
      }),
    ).toEqual({ kind: 'failed', reason: 'Pixxel · value too long' })
  })
})

describe('missing rates', () => {
  it('groups by currency with the earliest date, and never counts base or a covered event', () => {
    const out = missingRates(
      [
        { currency: 'INR', date: '2023-03-15', n: 4 },
        { currency: 'INR', date: '2022-01-01', n: 2 },
        { currency: 'USD', date: '2020-01-01', n: 9 },
        { currency: 'EUR', date: '2024-01-01', n: 1 },
        { currency: 'JPY', date: '2024-02-01', n: 1 },
      ],
      [{ currency: 'EUR', date: '2023-06-01', rateToBase: 1.08 }],
      'USD',
    )
    expect(out).toEqual([
      { currency: 'INR', events: 6, earliest: '2022-01-01' },
      { currency: 'JPY', events: 1, earliest: '2024-02-01' },
    ])
    expect(missingRateLine(out)).toBe(
      '6 events need an INR rate on or before 2022-01-01 · 1 event needs a JPY rate on or before 2024-02-01',
    )
  })
})

describe('the void line', () => {
  it('counts what a void reaches, and what it reversed; rounds stay', () => {
    expect(
      ledgerVoidLine({
        investments: 12,
        marks: 8,
        distributions: 0,
        voided: 0,
        rounds: 1,
      }),
    ).toBe('void reaches 12 investments · 8 marks · 1 round stays')
    expect(
      ledgerVoidLine({
        investments: 1,
        marks: 0,
        distributions: 2,
        voided: 3,
        rounds: 0,
      }),
    ).toBe('voided · 1 investment · 2 distributions reversed')
    expect(
      ledgerVoidLine({
        investments: 0,
        marks: 0,
        distributions: 0,
        voided: 0,
        rounds: 4,
      }),
    ).toBeNull()
  })
})
