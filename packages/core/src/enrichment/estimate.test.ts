import { describe, expect, it } from 'vitest'
import { estimateBulk, skippedTotal } from './estimate'
import type { EstimateRecord, EstimateSource } from './estimate'

/** The bulk estimate over facts the db half would read. */

const NOW = new Date('2026-10-10T15:30:00.000Z')
const DAY = 86_400_000

const apollo = (over: Partial<EstimateSource> = {}): EstimateSource => ({
  id: 'apollo',
  name: 'Apollo',
  local: false,
  cap: 100,
  spentToday: 0,
  rate: 1,
  ...over,
})
const website: EstimateSource = {
  id: 'website',
  name: 'Website',
  local: true,
  cap: null,
  spentToday: 0,
  rate: 0,
}

const record = (
  id: string,
  over: Partial<EstimateRecord> = {},
): EstimateRecord => ({
  id,
  sensitive: false,
  lastEnrichedAt: null,
  hasKey: true,
  queued: false,
  ...over,
})

const many = (n: number, prefix: string, over: Partial<EstimateRecord> = {}) =>
  Array.from({ length: n }, (_, i) => record(`${prefix}${String(i)}`, over))

describe('estimateBulk', () => {
  it('40 imported companies: 34 to ask, the skips counted by reason, credits against what is left', () => {
    const records = [
      ...many(34, 'ok'),
      ...many(2, 'sens', { sensitive: true }),
      ...many(2, 'fresh', { lastEnrichedAt: new Date(NOW.getTime() - DAY) }),
      ...many(1, 'nokey', { hasKey: false }),
      ...many(1, 'queued', { queued: true }),
    ]
    const out = estimateBulk({
      records,
      sources: [apollo()],
      reuseDays: 90,
      now: NOW,
    })
    expect(out.total).toBe(40)
    expect(out.ask).toBe(34)
    expect(out.parks).toBe(0)
    expect(out.skipped).toEqual({ sensitive: 2, reuse: 2, key: 1, queued: 1 })
    expect(skippedTotal(out.skipped)).toBe(6)
    expect(out.sources).toEqual([
      {
        id: 'apollo',
        name: 'Apollo',
        local: false,
        ask: 34,
        skipped: { sensitive: 2, reuse: 2, key: 1, queued: 1 },
        credits: 34,
        left: 100,
        parks: 0,
      },
    ])
    expect(out.plan.map((p) => p.entityId)).toEqual(
      records.slice(0, 34).map((r) => r.id),
    )
    expect(out.plan.every((p) => p.parkedBy === null)).toBe(true)
  })

  it('a sensitive record asks only the local source, and is skipped by the paid one', () => {
    const out = estimateBulk({
      records: [record('a'), record('s', { sensitive: true })],
      sources: [website, apollo()],
      reuseDays: 90,
      now: NOW,
    })
    expect(out.ask).toBe(2)
    expect(out.plan).toEqual([
      { entityId: 'a', sources: ['website', 'apollo'], parkedBy: null },
      { entityId: 's', sources: ['website'], parkedBy: null },
    ])
    expect(
      out.sources.map((s) => [s.name, s.ask, s.skipped.sensitive]),
    ).toEqual([
      ['Website', 2, 0],
      ['Apollo', 1, 1],
    ])
    expect(out.skipped).toEqual({ sensitive: 0, reuse: 0, key: 0, queued: 0 })
  })

  it('a record enriched longer ago than reuseDays is asked again', () => {
    const out = estimateBulk({
      records: [
        record('old', { lastEnrichedAt: new Date(NOW.getTime() - 8 * DAY) }),
      ],
      sources: [apollo()],
      reuseDays: 7,
      now: NOW,
    })
    expect(out.ask).toBe(1)
  })

  it('over the cap, the records past what is left park for the capped source', () => {
    const out = estimateBulk({
      records: [...many(10, 'c'), record('s', { sensitive: true })],
      sources: [website, apollo({ cap: 10, spentToday: 4 })],
      reuseDays: 90,
      now: NOW,
    })
    expect(out.ask).toBe(11)
    expect(out.parks).toBe(4)
    expect(
      out.plan.filter((p) => p.parkedBy === 'apollo').map((p) => p.entityId),
    ).toEqual(['c6', 'c7', 'c8', 'c9'])
    // The Website-only record never waits on Apollo's reset.
    expect(out.plan.find((p) => p.entityId === 's')?.parkedBy).toBeNull()
    const paid = out.sources.find((s) => s.id === 'apollo')
    expect(paid).toMatchObject({ ask: 10, credits: 10, left: 6, parks: 4 })
  })

  it('a rate above one credit fits fewer records under the cap', () => {
    const out = estimateBulk({
      records: many(5, 'r'),
      sources: [apollo({ cap: 5, rate: 2 })],
      reuseDays: 90,
      now: NOW,
    })
    expect(out.parks).toBe(3)
    expect(out.sources.at(0)?.credits).toBe(10)
  })

  it('no source asks nothing and skips nothing', () => {
    const out = estimateBulk({
      records: many(3, 'x', { hasKey: false }),
      sources: [],
      reuseDays: 90,
      now: NOW,
    })
    expect(out).toMatchObject({ total: 3, ask: 0, parks: 0, plan: [] })
    expect(skippedTotal(out.skipped)).toBe(0)
  })
})
