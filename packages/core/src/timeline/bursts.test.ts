import { describe, expect, it } from 'vitest'
import { BURST_GAP_MS, condenseBursts } from './bursts'
import type { BurstEventRow } from './bursts'

const T0 = new Date('2026-09-19T12:00:00.000Z')
const minutesBefore = (n: number) => new Date(T0.getTime() - n * 60_000)

const ev = (over: Partial<BurstEventRow>): BurstEventRow => ({
  attrSlug: 'sector',
  to: 'Fintech',
  actorType: 'user',
  actorId: null,
  actorRef: null,
  source: 'direct',
  at: T0,
  ...over,
})

const integrationEvent = (id: string, slug: string, at: Date) =>
  ev({
    attrSlug: slug,
    actorType: 'integration',
    actorId: null,
    actorRef: id,
    source: 'enrichment',
    at,
  })

describe('condenseBursts', () => {
  /**
   * The regression this module was extracted for. Before `actor_ref` the key
   * was (actorType, actorId, source), and two integrations both write with
   * actorType 'integration', a null actorId and source 'enrichment' — so a
   * minute apart they folded into one burst attributed to a single actor that
   * never did half the work.
   */
  it('keeps two integrations apart inside the gap', () => {
    const apollo = '11111111-1111-4111-8111-111111111111'
    const clearbit = '22222222-2222-4222-8222-222222222222'
    const bursts = condenseBursts([
      integrationEvent(clearbit, 'headcount', minutesBefore(0)),
      integrationEvent(apollo, 'sector', minutesBefore(1)),
    ])
    expect(bursts).toHaveLength(2)
    expect(bursts.map((b) => b.actorRef)).toEqual([clearbit, apollo])
    expect(bursts.map((b) => b.changes.length)).toEqual([1, 1])
  })

  it('folds one integration writing twice inside the gap', () => {
    const apollo = '11111111-1111-4111-8111-111111111111'
    const bursts = condenseBursts([
      integrationEvent(apollo, 'headcount', minutesBefore(0)),
      integrationEvent(apollo, 'sector', minutesBefore(1)),
    ])
    expect(bursts).toHaveLength(1)
    expect(bursts[0].actorRef).toBe(apollo)
    expect(bursts[0].changes.map((c) => c.slug)).toEqual([
      'headcount',
      'sector',
    ])
  })

  it('splits one integration either side of the gap', () => {
    const apollo = '11111111-1111-4111-8111-111111111111'
    const bursts = condenseBursts([
      integrationEvent(apollo, 'headcount', minutesBefore(0)),
      integrationEvent(apollo, 'sector', minutesBefore(11)),
    ])
    expect(bursts).toHaveLength(2)
    expect(BURST_GAP_MS).toBe(10 * 60 * 1000)
  })

  it('still folds one person and still splits a merge from their edits', () => {
    const me = 'user_anish'
    const bursts = condenseBursts([
      ev({ attrSlug: 'sector', actorId: me, at: minutesBefore(0) }),
      ev({ attrSlug: 'stage', actorId: me, at: minutesBefore(1) }),
      ev({
        attrSlug: 'location',
        actorType: 'system',
        actorId: null,
        source: 'merge',
        at: minutesBefore(2),
      }),
    ])
    expect(bursts).toHaveLength(2)
    expect(bursts[0].changes.map((c) => c.slug)).toEqual(['sector', 'stage'])
    expect(bursts[1].source).toBe('merge')
    expect(bursts[1].actor).toBe(null)
  })

  it('returns nothing for no events', () => {
    expect(condenseBursts([])).toEqual([])
  })
})
