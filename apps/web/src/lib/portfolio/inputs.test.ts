import { execValidator } from '@tanstack/react-start'
import { describe, expect, it } from 'vitest'
import { input } from '../server/input'
import { markInput, roundInput } from './inputs'

/**
 * The portfolio shapes at their edges, through the validator a server fn
 * runs. Every case here held against the shapes before they were Effect
 * schemas; the accept path of a `ledger_event` suggestion reads the same set.
 */

const HOLDING = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'
const COMPANY = '5c1f0b6e-2d0b-4c7e-8e3a-1a2b3c4d5e6f'

const mark = (over: Record<string, unknown>) =>
  execValidator(input(markInput), {
    holdingId: HOLDING,
    date: '2026-03-01',
    fairValue: 1000,
    currency: 'USD',
    basis: 'manual',
    ...over,
  })

const round = (over: Record<string, unknown>) =>
  execValidator(input(roundInput), {
    companyId: COMPANY,
    date: '2026-03-01',
    kind: 'Seed',
    ...over,
  })

describe('money (a mark’s fair value)', () => {
  it.each([0, -0, 1, 0.5, 1_000_000_000_000])('accepts %s', async (v) => {
    await expect(mark({ fairValue: v })).resolves.toMatchObject({
      fairValue: v,
    })
  })

  it.each([
    ['an empty string', ''],
    ['a negative', -1],
    ['a tiny negative', -0.0001],
    ['a non-number', 'abc'],
    ['a number as a string', '5'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['a boolean', true],
    ['absence', undefined],
  ])('refuses %s', async (_, v) => {
    await expect(mark({ fairValue: v })).rejects.toThrow(/fairValue/)
  })
})

describe('optional money (a round’s amount raised)', () => {
  it('accepts absence and zero', async () => {
    await expect(round({})).resolves.not.toHaveProperty('raised')
    await expect(round({ raised: 0 })).resolves.toMatchObject({ raised: 0 })
  })

  it.each([
    ['an empty string', ''],
    ['a negative', -5],
    ['a non-number', 'abc'],
    ['a number as a string', '5'],
    ['null', null],
  ])('refuses %s', async (_, v) => {
    await expect(round({ raised: v })).rejects.toThrow(/raised/)
  })
})

describe('isoDate', () => {
  it('accepts YYYY-MM-DD', async () => {
    await expect(mark({ date: '2026-12-31' })).resolves.toMatchObject({
      date: '2026-12-31',
    })
  })

  it.each([
    ['an empty string', ''],
    ['a short date', '2026-3-1'],
    ['words', 'March 2026'],
    ['a timestamp', '2026-03-01T00:00:00Z'],
    ['a number', 20260301],
  ])('refuses %s', async (_, v) => {
    await expect(mark({ date: v })).rejects.toThrow(/date/)
  })

  it('says Expected YYYY-MM-DD in its own words', async () => {
    await expect(mark({ date: 'March 2026' })).rejects.toThrow(
      /Expected YYYY-MM-DD/,
    )
  })
})

describe('currency', () => {
  it('uppercases three letters', async () => {
    await expect(mark({ currency: 'eur' })).resolves.toMatchObject({
      currency: 'EUR',
    })
  })

  it.each([
    ['an empty string', ''],
    ['two letters', 'US'],
    ['four letters', 'USDX'],
    ['a number', 840],
  ])('refuses %s', async (_, v) => {
    await expect(mark({ currency: v })).rejects.toThrow(/currency/)
  })
})

describe('roundInput', () => {
  it('trims the kind and drops a key it does not name', async () => {
    await expect(
      round({ kind: '  Series A ', role: 'admin' }),
    ).resolves.toEqual({
      companyId: COMPANY,
      date: '2026-03-01',
      kind: 'Series A',
    })
  })

  it.each([
    ['a blank kind', { kind: '   ' }],
    ['a long kind', { kind: 'x'.repeat(61) }],
    ['a non-uuid company', { companyId: 'acme' }],
    [
      'fifty-one co-investors',
      { coInvestorIds: Array.from({ length: 51 }, () => HOLDING) },
    ],
  ])('refuses %s', async (_, over) => {
    await expect(round(over)).rejects.toThrow()
  })

  it('accepts fifty co-investors', async () => {
    const coInvestorIds = Array.from({ length: 50 }, () => HOLDING)
    await expect(round({ coInvestorIds })).resolves.toMatchObject({
      coInvestorIds,
    })
  })
})

describe('markInput', () => {
  it('refuses a basis it does not know', async () => {
    await expect(mark({ basis: 'vibes' })).rejects.toThrow(/basis/)
  })

  it.each(['round_price', 'manual', '409a'])('accepts %s', async (basis) => {
    await expect(mark({ basis })).resolves.toMatchObject({ basis })
  })
})
