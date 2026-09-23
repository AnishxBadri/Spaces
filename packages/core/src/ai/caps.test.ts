import { describe, expect, it } from 'vitest'
import {
  capVerdict,
  estimateTokens,
  nextUtcMidnight,
  tokensToday,
  utcDayStart,
} from './caps'

const at = (
  iso: string,
  tokensIn: number | null,
  tokensOut: number | null,
) => ({
  at: new Date(iso),
  tokensIn,
  tokensOut,
})

// Straddles 2026-09-23 00:00 UTC: two rows the evening before, two after.
const ACROSS_MIDNIGHT = [
  at('2026-09-22T23:58:00.000Z', 400, 100),
  at('2026-09-22T23:59:59.999Z', 300, 200),
  at('2026-09-23T00:00:00.000Z', 60, 40),
  at('2026-09-23T00:01:00.000Z', 30, null),
]

describe('the UTC day', () => {
  it('starts at 00:00 UTC and resets at the next', () => {
    const now = new Date('2026-09-23T17:30:00.000Z')
    expect(utcDayStart(now).toISOString()).toBe('2026-09-23T00:00:00.000Z')
    expect(nextUtcMidnight(now).toISOString()).toBe('2026-09-24T00:00:00.000Z')
  })

  it('counts only rows since UTC midnight of now, in and out, a null as zero', () => {
    expect(
      tokensToday(ACROSS_MIDNIGHT, new Date('2026-09-23T00:05:00.000Z')),
    ).toBe(130)
    // One millisecond before midnight the same rows are yesterday's day.
    expect(
      tokensToday(ACROSS_MIDNIGHT, new Date('2026-09-22T23:59:59.999Z')),
    ).toBe(1000)
  })
})

describe('capVerdict', () => {
  it('never refuses with no cap configured', () => {
    expect(
      capVerdict({
        usage: ACROSS_MIDNIGHT,
        caps: {},
        now: new Date('2026-09-23T00:05:00.000Z'),
        estimate: 1_000_000,
      }),
    ).toEqual({ ok: true })
  })

  it('refuses at the ceiling, naming it and the next UTC midnight', () => {
    expect(
      capVerdict({
        usage: ACROSS_MIDNIGHT,
        caps: { dailyTokens: 1000 },
        now: new Date('2026-09-22T23:59:59.999Z'),
      }),
    ).toEqual({
      ok: false,
      kind: 'daily',
      ceiling: 1000,
      used: 1000,
      resetsAt: '2026-09-23T00:00:00.000Z',
    })
  })

  it('lets the same cap through once midnight has passed', () => {
    expect(
      capVerdict({
        usage: ACROSS_MIDNIGHT,
        caps: { dailyTokens: 1000 },
        now: new Date('2026-09-23T00:00:00.000Z'),
      }),
    ).toEqual({ ok: true })
  })

  it('runs a call one token below the ceiling — the check is before the call, not during it', () => {
    expect(
      capVerdict({
        usage: ACROSS_MIDNIGHT,
        caps: { dailyTokens: 131 },
        now: new Date('2026-09-23T12:00:00.000Z'),
        estimate: 5000,
      }),
    ).toEqual({ ok: true })
  })

  it('refuses a call whose estimate is over the per-run cap, and not one at it', () => {
    const now = new Date('2026-09-23T12:00:00.000Z')
    expect(
      capVerdict({
        usage: [],
        caps: { perRunTokens: 250 },
        now,
        estimate: 251,
      }),
    ).toEqual({
      ok: false,
      kind: 'per_run',
      ceiling: 250,
      used: 251,
      resetsAt: null,
    })
    expect(
      capVerdict({
        usage: [],
        caps: { perRunTokens: 250 },
        now,
        estimate: 250,
      }),
    ).toEqual({ ok: true })
  })

  it('names the daily cap first when both are exceeded', () => {
    const verdict = capVerdict({
      usage: ACROSS_MIDNIGHT,
      caps: { dailyTokens: 100, perRunTokens: 10 },
      now: new Date('2026-09-23T12:00:00.000Z'),
      estimate: 50,
    })
    expect(verdict).toMatchObject({ ok: false, kind: 'daily', used: 130 })
  })
})

describe('estimateTokens', () => {
  it('is characters ÷ 4, rounded up', () => {
    expect(estimateTokens(1000)).toBe(250)
    expect(estimateTokens(1001)).toBe(251)
    expect(estimateTokens(0)).toBe(0)
  })
})
