import { describe, expect, it } from 'vitest'
import { holdingMetrics } from './metrics'
import { ownership } from './ownership'
import { rateFor } from './fx'

const BASE = { baseCurrency: 'INR' }

describe('holdingMetrics', () => {
  it('computes the full kit for a single-currency holding, no rates needed', () => {
    const result = holdingMetrics(
      {
        investments: [
          { date: '2022-01-01', amount: 100, currency: 'USD' },
          { date: '2023-01-01', amount: 50, currency: 'USD' },
        ],
        marks: [{ date: '2024-01-01', fairValue: 450, currency: 'USD' }],
        distributions: [
          { date: '2023-06-01', amount: 30, currency: 'USD', kind: 'dividend' },
        ],
      },
      BASE,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const m = result.metrics
    expect(m.currency).toBe('USD')
    expect(m.costBasis).toBe(150)
    expect(m.realized).toBe(30)
    expect(m.unrealized).toBe(450)
    expect(m.moic).toBeCloseTo(480 / 150, 10)
    expect(m.dpi).toBeCloseTo(30 / 150, 10)
    expect(m.rvpi).toBeCloseTo(450 / 150, 10)
    expect(m.lastMarkDate).toBe('2024-01-01')
    expect(m.grossXirr).toBeGreaterThan(0)
  })

  it('falls back to cost basis when never marked, with staleness visible', () => {
    const result = holdingMetrics(
      {
        investments: [{ date: '2023-01-01', amount: 100, currency: 'INR' }],
        marks: [],
        distributions: [],
      },
      BASE,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metrics.unrealized).toBe(100)
    expect(result.metrics.lastMarkDate).toBeNull()
    expect(result.metrics.moic).toBeCloseTo(1, 10)
  })

  it('write-off zeroes unrealized even without a final zero mark', () => {
    const result = holdingMetrics(
      {
        investments: [{ date: '2022-01-01', amount: 100, currency: 'INR' }],
        marks: [{ date: '2022-06-01', fairValue: 300, currency: 'INR' }],
        distributions: [
          { date: '2024-01-01', amount: 0, currency: 'INR', kind: 'writeoff' },
        ],
      },
      BASE,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metrics.writtenOff).toBe(true)
    expect(result.metrics.unrealized).toBe(0)
    expect(result.metrics.moic).toBeCloseTo(0, 10)
    expect(result.metrics.grossXirr).toBe(-1)
  })

  it('as-of filters events: the past has no knowledge of later marks', () => {
    const events = {
      investments: [{ date: '2022-01-01', amount: 100, currency: 'INR' }],
      marks: [
        { date: '2022-12-01', fairValue: 200, currency: 'INR' },
        { date: '2024-01-01', fairValue: 800, currency: 'INR' },
      ],
      distributions: [],
    }
    const at2023 = holdingMetrics(events, { ...BASE, asOf: '2023-06-30' })
    expect(at2023.ok).toBe(true)
    if (!at2023.ok) return
    expect(at2023.metrics.unrealized).toBe(200)
    expect(at2023.metrics.lastMarkDate).toBe('2022-12-01')
  })

  it('mixed currencies convert flows at transaction-date rates, marks at as-of', () => {
    const result = holdingMetrics(
      {
        investments: [{ date: '2022-01-01', amount: 100, currency: 'USD' }],
        marks: [{ date: '2023-01-01', fairValue: 200, currency: 'USD' }],
        distributions: [
          { date: '2023-01-01', amount: 10, currency: 'INR', kind: 'dividend' },
        ],
      },
      {
        baseCurrency: 'INR',
        asOf: '2023-06-01',
        fxRates: [
          { currency: 'USD', date: '2022-01-01', rateToBase: 75 },
          { currency: 'USD', date: '2023-05-01', rateToBase: 82 },
        ],
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // check at historical 75, mark at as-of-date rate 82
    expect(result.metrics.currency).toBe('INR')
    expect(result.metrics.costBasis).toBe(7500)
    expect(result.metrics.realized).toBe(10)
    expect(result.metrics.unrealized).toBe(16400)
  })

  it('surfaces missing rates instead of faking 1.0', () => {
    const result = holdingMetrics(
      {
        investments: [{ date: '2022-01-01', amount: 100, currency: 'USD' }],
        marks: [],
        distributions: [
          { date: '2023-01-01', amount: 5, currency: 'INR', kind: 'dividend' },
        ],
      },
      { baseCurrency: 'INR', fxRates: [] },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.missingRates).toEqual([
      { currency: 'USD', date: '2022-01-01' },
    ])
  })
})

describe('ownership', () => {
  it('builds a dilution history from priced shares and FD counts', () => {
    const o = ownership(
      [
        {
          date: '2022-01-01',
          amount: 100,
          instrument: 'priced',
          shares: 1000,
        },
      ],
      [
        { date: '2022-01-01', kind: 'Seed', sharesOutstanding: 10000 },
        { date: '2023-01-01', kind: 'Series A', sharesOutstanding: 20000 },
      ],
    )
    expect(o.kind).toBe('actual')
    if (o.kind !== 'actual') return
    expect(o.history).toHaveLength(2)
    expect(o.history[0].pct).toBeCloseTo(0.1, 10)
    expect(o.history[1].pct).toBeCloseTo(0.05, 10)
    expect(o.currentPct).toBeCloseTo(0.05, 10)
  })

  it('post-money SAFE shows implied % locked at signing', () => {
    const o = ownership(
      [
        {
          date: '2023-01-01',
          amount: 100_000,
          instrument: 'safe_post_money',
          cap: 5_000_000,
        },
      ],
      [],
    )
    expect(o).toEqual({ kind: 'implied', pct: 0.02 })
  })

  it('pre-money SAFEs and CCDs never fake a percentage', () => {
    for (const instrument of ['safe_pre_money', 'ccd'] as const) {
      const o = ownership(
        [{ date: '2023-01-01', amount: 100_000, instrument, cap: 5_000_000 }],
        [],
      )
      expect(o).toEqual({ kind: 'cost_basis_only' })
    }
  })

  it('mixed post-money SAFE + unconverted CCD degrades to cost basis', () => {
    const o = ownership(
      [
        {
          date: '2023-01-01',
          amount: 100_000,
          instrument: 'safe_post_money',
          cap: 5_000_000,
        },
        { date: '2023-06-01', amount: 50_000, instrument: 'ccd' },
      ],
      [],
    )
    expect(o).toEqual({ kind: 'cost_basis_only' })
  })
})

describe('rateFor', () => {
  const rates = [
    { currency: 'USD', date: '2022-01-01', rateToBase: 75 },
    { currency: 'USD', date: '2023-01-01', rateToBase: 82 },
  ]
  it('picks the latest rate on or before the date', () => {
    expect(rateFor(rates, 'USD', '2022-06-01', 'INR')).toBe(75)
    expect(rateFor(rates, 'USD', '2023-01-01', 'INR')).toBe(82)
  })
  it('base currency is always 1; unknown is null, never 1', () => {
    expect(rateFor(rates, 'INR', '2022-06-01', 'INR')).toBe(1)
    expect(rateFor(rates, 'EUR', '2022-06-01', 'INR')).toBeNull()
    expect(rateFor(rates, 'USD', '2021-01-01', 'INR')).toBeNull()
  })
})
