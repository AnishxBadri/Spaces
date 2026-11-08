import { describe, expect, it } from 'vitest'
import { ownership } from './ownership'
import type { OwnershipInvestment, OwnershipRound } from './ownership'

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
      ownership([priced()], [{ ...seed, sharesOutstanding: null }]),
    ).toEqual({ kind: 'cost_basis_only', reason: 'shares_outstanding_unknown' })
  })

  it('a priced check without its own share count', () => {
    expect(ownership([priced({ shares: null })], [seed])).toEqual({
      kind: 'cost_basis_only',
      reason: 'shares_unknown',
    })
  })

  it('a priced check whose only count is from a round before it', () => {
    expect(ownership([priced({ date: '2024-06-01' })], [seed])).toEqual({
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
      expect(ownership([check], [seed])).toEqual({
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
      ownership([capped, priced({ instrument: 'ccd', shares: null })], []),
    ).toEqual({ kind: 'cost_basis_only', reason: 'mixed' })
    expect(ownership([capped, priced()], [])).toEqual({
      kind: 'cost_basis_only',
      reason: 'mixed',
    })
  })

  it('nothing standing at the as-of day', () => {
    expect(
      ownership([priced({ date: '2024-01-01' })], [seed], '2023-06-30'),
    ).toEqual({ kind: 'cost_basis_only', reason: 'no_checks' })
  })

  it('names no reason when there is a percentage', () => {
    expect(ownership([priced()], [seed]).kind).toBe('actual')
  })
})
