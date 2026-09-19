import { describe, expect, it } from 'vitest'
import { holdingMetrics } from './metrics'
import type { HoldingEvents } from './metrics'
import { ownership } from './ownership'
import { liveAt, reversalInEffect } from './reversal'

/**
 * Corrections are appends (D12, SPA-150), proven where it matters: the
 * derived numbers. The loader hands these functions only originals, each
 * stamped with `reversedAt`; a voided one returns the metrics to *exactly*
 * their pre-entry values, and an as-of date before the void still sees it.
 */

const BASE = { baseCurrency: 'USD' }
/** The instant somebody decided an entry was wrong. */
const VOIDED_AT = '2025-03-04T11:20:00.000Z'

const check = (date: string, amount: number) => ({
  date,
  amount,
  currency: 'USD',
})

describe('reversalInEffect', () => {
  it('a live event is never in effect, with or without an as-of', () => {
    expect(reversalInEffect(null)).toBe(false)
    expect(reversalInEffect(undefined, '2024-01-01')).toBe(false)
  })

  it('no as-of means every void that has happened is in effect', () => {
    expect(reversalInEffect(VOIDED_AT)).toBe(true)
  })

  it('the void takes effect on its own day, end of day', () => {
    expect(reversalInEffect(VOIDED_AT, '2025-03-03')).toBe(false)
    // same day, later in the day than the timestamp or not: end-of-day
    expect(reversalInEffect(VOIDED_AT, '2025-03-04')).toBe(true)
    expect(reversalInEffect(VOIDED_AT, '2025-03-05')).toBe(true)
  })

  it('liveAt keeps what still stands', () => {
    const rows = [
      { id: 'a', reversedAt: null },
      { id: 'b', reversedAt: VOIDED_AT },
    ]
    expect(liveAt(rows).map((r) => r.id)).toEqual(['a'])
    expect(liveAt(rows, '2025-01-01').map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('voiding an investment', () => {
  const before: HoldingEvents = {
    investments: [check('2022-01-01', 100)],
    marks: [{ date: '2024-01-01', fairValue: 400, currency: 'USD' }],
    distributions: [],
  }
  /** The same ledger, plus a wrong second check that was then voided. */
  const after: HoldingEvents = {
    investments: [
      check('2022-01-01', 100),
      { ...check('2023-01-01', 60), reversedAt: VOIDED_AT },
    ],
    marks: before.marks,
    distributions: [],
  }

  it('returns cost basis, MOIC and gross XIRR to exactly their pre-entry values', () => {
    const a = holdingMetrics(before, BASE)
    const b = holdingMetrics(after, BASE)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.metrics.costBasis).toBe(a.metrics.costBasis)
    expect(b.metrics.moic).toBe(a.metrics.moic)
    expect(b.metrics.grossXirr).toBe(a.metrics.grossXirr)
    expect(b.metrics.tvpi).toBe(a.metrics.tvpi)
    expect(b.metrics.dpi).toBe(a.metrics.dpi)
  })

  it('an as-of date before the void still sees the original', () => {
    const asOf = '2024-06-30'
    const seen = holdingMetrics(after, { ...BASE, asOf })
    expect(seen.ok).toBe(true)
    if (!seen.ok) return
    expect(seen.metrics.costBasis).toBe(160)

    const gone = holdingMetrics(after, { ...BASE, asOf: '2025-06-30' })
    expect(gone.ok).toBe(true)
    if (!gone.ok) return
    expect(gone.metrics.costBasis).toBe(100)
  })
})

describe('voiding a mark', () => {
  it('restores the previous mark as latest', () => {
    const events: HoldingEvents = {
      investments: [check('2022-01-01', 100)],
      marks: [
        { date: '2023-01-01', fairValue: 300, currency: 'USD' },
        {
          date: '2024-01-01',
          fairValue: 750_000,
          currency: 'USD',
          reversedAt: VOIDED_AT,
        },
      ],
      distributions: [],
    }
    const after = holdingMetrics(events, BASE)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.metrics.lastMarkDate).toBe('2023-01-01')
    expect(after.metrics.unrealized).toBe(300)
    expect(after.metrics.moic).toBe(3)

    // Before the void, the fat mark is still what was believed.
    const during = holdingMetrics(events, { ...BASE, asOf: '2024-06-30' })
    expect(during.ok).toBe(true)
    if (!during.ok) return
    expect(during.metrics.lastMarkDate).toBe('2024-01-01')
    expect(during.metrics.unrealized).toBe(750_000)
  })
})

describe('voiding a write-off', () => {
  it('clears writtenOff and brings value back to the latest mark', () => {
    const events: HoldingEvents = {
      investments: [check('2022-01-01', 100)],
      marks: [{ date: '2023-01-01', fairValue: 250, currency: 'USD' }],
      distributions: [
        {
          date: '2024-01-01',
          amount: 0,
          currency: 'USD',
          kind: 'writeoff',
          reversedAt: VOIDED_AT,
        },
      ],
    }
    const after = holdingMetrics(events, BASE)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.metrics.writtenOff).toBe(false)
    expect(after.metrics.unrealized).toBe(250)

    const during = holdingMetrics(events, { ...BASE, asOf: '2024-06-30' })
    expect(during.ok).toBe(true)
    if (!during.ok) return
    expect(during.metrics.writtenOff).toBe(true)
    expect(during.metrics.unrealized).toBe(0)
  })
})

describe('voiding a priced investment', () => {
  const rounds = [
    { date: '2022-06-01', kind: 'seed', sharesOutstanding: 1_000_000 },
    { date: '2023-06-01', kind: 'series a', sharesOutstanding: 2_000_000 },
  ]

  it('restores the prior ownership history', () => {
    const live = [
      {
        date: '2022-01-01',
        amount: 100,
        instrument: 'priced' as const,
        shares: 100_000,
      },
    ]
    const withVoided = [
      ...live,
      {
        date: '2023-01-01',
        amount: 200,
        instrument: 'priced' as const,
        shares: 400_000,
        reversedAt: VOIDED_AT,
      },
    ]
    expect(ownership(withVoided, rounds)).toEqual(ownership(live, rounds))

    const before = ownership(withVoided, rounds, '2024-06-30')
    expect(before.kind).toBe('actual')
    if (before.kind !== 'actual') return
    // 500,000 of 2,000,000 — what was believed before the void.
    expect(before.currentPct).toBe(0.25)
  })

  it('does not lean on the negated shares to cancel', () => {
    // The compensating row never reaches the lib; were it passed in, the
    // `shares > 0` filter would silently drop it and the % would be wrong.
    const o = ownership(
      [
        {
          date: '2022-01-01',
          amount: 100,
          instrument: 'priced',
          shares: 100_000,
          reversedAt: VOIDED_AT,
        },
      ],
      rounds,
    )
    expect(o).toEqual({ kind: 'cost_basis_only' })
  })
})
