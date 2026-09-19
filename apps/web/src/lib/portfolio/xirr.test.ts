import { describe, expect, it } from 'vitest'
import { xirr } from './xirr'

describe('xirr', () => {
  it('recovers the closed-form rate for a single in/out pair', () => {
    // 100 → 200 over exactly 2 years (730 days): r = 2^(1/2) - 1
    const r = xirr([
      { date: '2020-01-01', amount: -100 },
      { date: '2021-12-31', amount: 200 },
    ])
    expect(r).not.toBeNull()
    expect(r ?? 0).toBeCloseTo(Math.SQRT2 - 1, 6)
  })

  it('matches Excel XIRR on a multi-flow schedule', () => {
    // Excel: XIRR({-10000,2750,4250,3250,2750}, {2008-01-01,2008-03-01,
    // 2008-10-30,2009-02-15,2009-04-01}) = 0.373362535 (Excel uses
    // Actual/365 like we do)
    const r = xirr([
      { date: '2008-01-01', amount: -10000 },
      { date: '2008-03-01', amount: 2750 },
      { date: '2008-10-30', amount: 4250 },
      { date: '2009-02-15', amount: 3250 },
      { date: '2009-04-01', amount: 2750 },
    ])
    expect(r).not.toBeNull()
    expect(r ?? 0).toBeCloseTo(0.373362535, 5)
  })

  it('handles deeply negative rates via bisection', () => {
    // 100 → 1 over 1 year: r = -99%
    const r = xirr([
      { date: '2020-01-01', amount: -100 },
      { date: '2020-12-31', amount: 1 },
    ])
    expect(r).not.toBeNull()
    expect(r ?? 0).toBeCloseTo(-0.99, 3)
  })

  it('is order-insensitive', () => {
    const a = xirr([
      { date: '2021-12-31', amount: 200 },
      { date: '2020-01-01', amount: -100 },
    ])
    const b = xirr([
      { date: '2020-01-01', amount: -100 },
      { date: '2021-12-31', amount: 200 },
    ])
    expect(a).toBeCloseTo(b ?? 0, 10)
  })

  it('returns null when undefined', () => {
    expect(xirr([])).toBeNull()
    expect(xirr([{ date: '2020-01-01', amount: -100 }])).toBeNull()
    expect(
      xirr([
        { date: '2020-01-01', amount: -100 },
        { date: '2021-01-01', amount: -50 },
      ]),
    ).toBeNull()
    expect(
      xirr([
        { date: '2020-01-01', amount: 100 },
        { date: '2021-01-01', amount: 50 },
      ]),
    ).toBeNull()
  })

  it('zero elapsed time is undefined, not the solver guess', () => {
    expect(
      xirr([
        { date: '2024-06-15', amount: -250000 },
        { date: '2024-06-15', amount: 250000 },
      ]),
    ).toBeNull()
  })

  it('total loss lands at the domain floor', () => {
    const r = xirr([
      { date: '2020-01-01', amount: -100 },
      { date: '2022-01-01', amount: 0.000001 },
    ])
    expect(r).not.toBeNull()
    expect(r ?? 0).toBeLessThan(-0.99)
  })
})
