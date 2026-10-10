import { describe, expect, it } from 'vitest'
import { holdingMetrics } from './metrics'
import type { HoldingEvents } from './metrics'
import { portfolioRollup } from './rollup'
import { xirr } from './xirr'

const USD = { baseCurrency: 'USD', fxRates: [] }

const alpha: HoldingEvents = {
  investments: [{ date: '2022-01-01', amount: 100, currency: 'USD' }],
  marks: [{ date: '2024-01-01', fairValue: 300, currency: 'USD' }],
  distributions: [
    { date: '2023-01-01', amount: 20, currency: 'USD', kind: 'dividend' },
  ],
}
const bravo: HoldingEvents = {
  investments: [{ date: '2023-01-01', amount: 200, currency: 'USD' }],
  marks: [{ date: '2023-07-01', fairValue: 150, currency: 'USD' }],
  distributions: [],
}

describe('portfolioRollup — the book’s XIRR', () => {
  it('is the holding’s own XIRR when the book is one holding', () => {
    const one = holdingMetrics(alpha, USD)
    const book = portfolioRollup([{ id: 'a', events: alpha }], USD)
    expect(one.ok).toBe(true)
    if (!one.ok) return
    expect(book.grossXirr).toBeCloseTo(one.metrics.grossXirr ?? NaN, 12)
  })

  it('pools every holding’s cash with what is still held at the as-of date', () => {
    const asOf = '2024-06-30'
    const book = portfolioRollup(
      [
        { id: 'a', events: alpha },
        { id: 'b', events: bravo },
      ],
      { ...USD, asOf },
    )
    const expected = xirr([
      { date: '2022-01-01', amount: -100 },
      { date: '2023-01-01', amount: 20 },
      { date: '2023-01-01', amount: -200 },
      { date: asOf, amount: 300 + 150 },
    ])
    expect(book.grossXirr).toBeCloseTo(expected ?? NaN, 12)
  })

  it('leaves a holding with a missing rate out of the pool, and reads a total loss as -100%', () => {
    const unpriced: HoldingEvents = {
      investments: [{ date: '2022-01-01', amount: 1_000, currency: 'SGD' }],
      marks: [],
      distributions: [],
    }
    const withUnpriced = portfolioRollup(
      [
        { id: 'a', events: alpha },
        { id: 's', events: unpriced },
      ],
      USD,
    )
    const alone = portfolioRollup([{ id: 'a', events: alpha }], USD)
    expect(withUnpriced.excludedForMissingRates).toEqual(['s'])
    expect(withUnpriced.grossXirr).toBe(alone.grossXirr)

    const lost = portfolioRollup(
      [
        {
          id: 'w',
          events: {
            investments: [{ date: '2022-01-01', amount: 50, currency: 'USD' }],
            marks: [],
            distributions: [
              {
                date: '2023-01-01',
                amount: 0,
                currency: 'USD',
                kind: 'writeoff',
              },
            ],
          },
        },
      ],
      USD,
    )
    expect(lost.grossXirr).toBe(-1)
  })
})
