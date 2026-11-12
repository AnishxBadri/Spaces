import { describe, expect, it } from 'vitest'
import { ownership } from './ownership'
import type {
  OwnershipInvestment,
  OwnershipRound,
  OwnershipSale,
} from './ownership'

/**
 * Why a holding falls back to cost basis, named for the Ownership rail:
 * one reason per way the percentage could not be had.
 */

const priced = (
  over: Partial<OwnershipInvestment> = {},
): OwnershipInvestment => ({
  date: '2023-01-01',
  amount: 100_000,
  instrument: 'priced',
  shares: 10_000,
  ...over,
})

const seed: OwnershipRound = {
  date: '2023-01-01',
  kind: 'Seed',
  sharesOutstanding: 1_000_000,
}

describe('ownership: why cost basis only', () => {
  it('a priced check whose rounds carry no fully-diluted count', () => {
    expect(
      ownership([priced()], [{ ...seed, sharesOutstanding: null }], []),
    ).toEqual({ kind: 'cost_basis_only', reason: 'shares_outstanding_unknown' })
  })

  it('a priced check without its own share count', () => {
    expect(ownership([priced({ shares: null })], [seed], [])).toEqual({
      kind: 'cost_basis_only',
      reason: 'shares_unknown',
    })
  })

  it('a priced check whose only count is from a round before it', () => {
    expect(ownership([priced({ date: '2024-06-01' })], [seed], [])).toEqual({
      kind: 'cost_basis_only',
      reason: 'shares_outstanding_unknown',
    })
  })

  it('an unconverted instrument: pre-money SAFE, CCD, uncapped post-money SAFE', () => {
    for (const check of [
      priced({ instrument: 'safe_pre_money', shares: null, cap: 5_000_000 }),
      priced({ instrument: 'ccd', shares: null }),
      priced({ instrument: 'safe_post_money', shares: null, cap: null }),
    ])
      expect(ownership([check], [seed], [])).toEqual({
        kind: 'cost_basis_only',
        reason: 'unconverted',
      })
    // Two kinds that are both unconverted are still the one reason.
    expect(
      ownership(
        [
          priced({ instrument: 'safe_pre_money', shares: null }),
          priced({ instrument: 'ccd', shares: null }),
        ],
        [],
        [],
      ),
    ).toEqual({ kind: 'cost_basis_only', reason: 'unconverted' })
  })

  it('mixed instruments whose percentages do not add up', () => {
    const capped = priced({
      instrument: 'safe_post_money',
      shares: null,
      cap: 5_000_000,
    })
    expect(
      ownership([capped, priced({ instrument: 'ccd', shares: null })], [], []),
    ).toEqual({ kind: 'cost_basis_only', reason: 'mixed' })
    expect(ownership([capped, priced()], [], [])).toEqual({
      kind: 'cost_basis_only',
      reason: 'mixed',
    })
  })

  it('nothing standing at the as-of day', () => {
    expect(
      ownership([priced({ date: '2024-01-01' })], [seed], [], '2023-06-30'),
    ).toEqual({ kind: 'cost_basis_only', reason: 'no_checks' })
  })

  it('names no reason when there is a percentage', () => {
    expect(ownership([priced()], [seed], []).kind).toBe('actual')
  })
})

const sale = (over: Partial<OwnershipSale> = {}): OwnershipSale => ({
  date: '2024-01-01',
  sharesSold: 4_000,
  ...over,
})

describe('ownership: shares sold', () => {
  const rounds: Array<OwnershipRound> = [
    seed,
    { date: '2025-01-01', kind: 'Series A', sharesOutstanding: 2_000_000 },
  ]

  const actual = (o: ReturnType<typeof ownership>) => {
    if (o.kind !== 'actual') throw new Error(`expected actual, got ${o.kind}`)
    return o
  }

  it('a holding with no sales is unchanged', () => {
    expect(ownership([priced()], rounds, [])).toEqual({
      kind: 'actual',
      history: [
        {
          date: '2023-01-01',
          roundKind: 'Seed',
          ourShares: 10_000,
          sharesOutstanding: 1_000_000,
          pct: 0.01,
        },
        {
          date: '2025-01-01',
          roundKind: 'Series A',
          ourShares: 10_000,
          sharesOutstanding: 2_000_000,
          pct: 0.005,
        },
      ],
      currentPct: 0.005,
    })
  })

  it('a partial sale between two rounds counts from the next round on', () => {
    const o = actual(ownership([priced()], rounds, [sale()]))
    expect(o.history.map((p) => [p.roundKind, p.ourShares, p.pct])).toEqual([
      ['Seed', 10_000, 0.01],
      ['Series A', 6_000, 0.003],
    ])
    expect(o.currentPct).toBe(0.003)
  })

  it('a sale on a round day counts at that round', () => {
    const o = actual(
      ownership([priced()], rounds, [sale({ date: '2025-01-01' })]),
    )
    expect(o.history.map((p) => p.ourShares)).toEqual([10_000, 6_000])
    expect(o.history).toHaveLength(2)
  })

  it('a sale after the last round adds a point over the last count', () => {
    const o = actual(
      ownership([priced()], rounds, [sale({ date: '2025-06-01' })]),
    )
    expect(o.history.at(-1)).toEqual({
      date: '2025-06-01',
      roundKind: 'sale',
      ourShares: 6_000,
      sharesOutstanding: 2_000_000,
      pct: 0.003,
    })
    expect(o.history).toHaveLength(3)
    expect(o.currentPct).toBe(0.003)
  })

  it('two sales after the last round are a point each, one per day', () => {
    const o = actual(
      ownership([priced()], rounds, [
        sale({ date: '2025-06-01', sharesSold: 1_000 }),
        sale({ date: '2025-06-01', sharesSold: 1_000 }),
        sale({ date: '2025-09-01', sharesSold: 2_000 }),
      ]),
    )
    expect(
      o.history
        .filter((p) => p.roundKind === 'sale')
        .map((p) => [p.date, p.ourShares]),
    ).toEqual([
      ['2025-06-01', 8_000],
      ['2025-09-01', 6_000],
    ])
  })

  it('a full exit reads zero, and the point is not skipped', () => {
    const o = actual(
      ownership([priced()], rounds, [
        sale({ date: '2025-06-01', sharesSold: 10_000 }),
      ]),
    )
    expect(o.history.at(-1)).toMatchObject({
      roundKind: 'sale',
      ourShares: 0,
      pct: 0,
    })
    expect(o.currentPct).toBe(0)
  })

  it('a round after a full exit reads zero rather than dropping out', () => {
    const o = actual(
      ownership([priced()], rounds, [sale({ sharesSold: 10_000 })]),
    )
    expect(o.history.map((p) => p.pct)).toEqual([0.01, 0])
  })

  it('selling more than was held floors at zero', () => {
    const o = actual(
      ownership([priced()], rounds, [sale({ sharesSold: 25_000 })]),
    )
    expect(o.history.at(-1)).toMatchObject({ ourShares: 0, pct: 0 })
    expect(o.currentPct).toBe(0)
  })

  it('a round before the first purchase is still skipped', () => {
    const o = actual(
      ownership([priced({ date: '2024-06-01' })], rounds, [
        sale({ date: '2024-01-01' }),
      ]),
    )
    expect(o.history.map((p) => p.roundKind)).toEqual(['Series A'])
  })

  it('a distribution with no shares sold changes nothing', () => {
    expect(
      ownership([priced()], rounds, [
        sale({ sharesSold: null }),
        sale({ date: '2025-06-01', sharesSold: 0 }),
      ]),
    ).toEqual(ownership([priced()], rounds, []))
  })

  it('a sale after as-of does not count, and adds no point', () => {
    expect(
      ownership(
        [priced()],
        rounds,
        [sale({ date: '2025-06-01' })],
        '2025-03-01',
      ),
    ).toEqual(ownership([priced()], rounds, [], '2025-03-01'))
  })

  describe('a voided sale', () => {
    const VOIDED_AT = '2025-09-15T10:00:00.000Z'
    const voided = sale({ date: '2025-06-01', reversedAt: VOIDED_AT })

    it('counts at an as-of day before the void instant', () => {
      const o = actual(ownership([priced()], rounds, [voided], '2025-09-14'))
      expect(o.history.at(-1)).toMatchObject({
        date: '2025-06-01',
        roundKind: 'sale',
        ourShares: 6_000,
      })
      expect(o.currentPct).toBe(0.003)
    })

    it('stops counting once the as-of day reaches the void', () => {
      expect(ownership([priced()], rounds, [voided], '2025-09-15')).toEqual(
        ownership([priced()], rounds, [], '2025-09-15'),
      )
      expect(ownership([priced()], rounds, [voided])).toEqual(
        ownership([priced()], rounds, []),
      )
    })
  })

  it('leaves an implied percentage alone', () => {
    const safe = priced({
      instrument: 'safe_post_money',
      shares: null,
      cap: 5_000_000,
    })
    expect(ownership([safe], rounds, [sale()])).toEqual({
      kind: 'implied',
      pct: 0.02,
    })
  })

  it('leaves a cost-basis-only holding alone', () => {
    expect(
      ownership([priced({ instrument: 'ccd', shares: null })], rounds, [
        sale(),
      ]),
    ).toEqual({ kind: 'cost_basis_only', reason: 'unconverted' })
  })
})
