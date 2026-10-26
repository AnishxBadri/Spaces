import { describe, expect, it } from 'vitest'
import { fmtRate, fxLedgerRows } from './fx-ledger'

const TODAY = '2026-10-26'

describe('fxLedgerRows', () => {
  it('prints a range on each superseded rate and lists the live ones first', () => {
    const rows = fxLedgerRows(
      [
        { currency: 'EUR', date: '2026-07-01', rateToBase: 1.072 },
        { currency: 'GBP', date: '2026-09-15', rateToBase: 1.265 },
        { currency: 'EUR', date: '2026-10-01', rateToBase: 1.09 },
        { currency: 'EUR', date: '2026-04-01', rateToBase: 1.05 },
      ],
      TODAY,
    )
    expect(rows.map((r) => [r.currency, r.date, r.live, r.appliesTo])).toEqual([
      ['EUR', '2026-10-01', true, 'events from 1 Oct'],
      ['GBP', '2026-09-15', true, 'events from 15 Sep'],
      ['EUR', '2026-07-01', false, 'events 1 Jul to 30 Sep'],
      ['EUR', '2026-04-01', false, 'events 1 Apr to 30 Jun'],
    ])
  })

  it('never prints the same clause on two rows of one currency', () => {
    const rows = fxLedgerRows(
      [
        { currency: 'EUR', date: '2026-03-01', rateToBase: 1.0 },
        { currency: 'EUR', date: '2026-02-28', rateToBase: 1.0 },
        { currency: 'EUR', date: '2026-02-01', rateToBase: 1.0 },
      ],
      TODAY,
    )
    expect(rows.map((r) => r.appliesTo)).toEqual([
      'events from 1 Mar',
      'events on 28 Feb',
      'events 1 Feb to 27 Feb',
    ])
  })
})

describe('fmtRate', () => {
  it('pads to four places and keeps any more', () => {
    expect(fmtRate(1.09)).toBe('1.0900')
    expect(fmtRate(0.00671234)).toBe('0.00671234')
    expect(fmtRate(110)).toBe('110.0000')
  })
})
