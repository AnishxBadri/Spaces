import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  attributeEvent,
  entity,
  interaction,
  interactionEntity,
  objectDef,
  signal,
} from '@spaces/db/schema'
import { holding, investment, round } from '@spaces/db/schema/portfolio'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import type { Actor } from '@spaces/core/writes/attributes/values'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { birthDealInTx } from '#/lib/deals/birth'
import { setPersonCompanyProgram } from '#/lib/people/companies'
import {
  companyReadoutsProgram,
  dealReadoutsProgram,
  personReadoutsProgram,
  recordReadoutsProgram,
} from './readouts'
import { localDay } from './readout-format'

/**
 * The record strip's cells, read against seeded interactions and signals:
 * dates are local calendar days, and a record with nothing to measure reads
 * null (the page prints a graphite dash), never zero.
 */

const ME: Actor = { type: 'user', id: FIXTURE_ACTOR.id }
const NOW = new Date('2026-10-05T12:00:00')
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

async function aCompany(name: string) {
  const tag = randomUUID().slice(0, 8)
  const c = await resolveEntity({
    kind: 'company',
    name: `${name} ${tag}`,
    keys: { domain: `${name.toLowerCase()}-${tag}.example` },
    source: { class: 'manual' },
  })
  return c.entityId
}

async function aPerson(name: string) {
  const p = await resolveEntity({
    kind: 'person',
    name,
    source: { class: 'manual' },
  })
  return p.entityId
}

async function interact(
  kind: 'email' | 'meeting' | 'call',
  at: Date,
  entityIds: Array<string>,
) {
  const row = (
    await db
      .insert(interaction)
      .values({ kind, occurredAt: at })
      .returning({ id: interaction.id })
  ).at(0)
  if (!row) throw new Error('no interaction')
  await db
    .insert(interactionEntity)
    .values(entityIds.map((entityId) => ({ interactionId: row.id, entityId })))
}

async function aDeal(
  companyId: string,
  values: Record<string, unknown> = {},
  stage = 'diligence',
) {
  const born = await db.transaction((tx) =>
    birthDealInTx(tx, {
      name: `Deal ${randomUUID().slice(0, 6)}`,
      companyId,
      stage,
      values,
      actorId: FIXTURE_ACTOR.id,
      source: 'manual',
    }),
  )
  return born.id
}

/** Backdates the deal's entry into its current stage. */
async function enteredStage(dealId: string, at: Date) {
  await db
    .update(attributeEvent)
    .set({ at })
    .where(
      and(
        eq(attributeEvent.entityId, dealId),
        eq(attributeEvent.attrSlug, 'stage'),
      ),
    )
}

describe('person readouts', () => {
  it('reads the latest, the latest email and the earliest interaction', async () => {
    const p = await aPerson('Asha Rao')
    await interact('email', daysAgo(10), [p])
    await interact('meeting', daysAgo(1), [p])
    await interact('call', daysAgo(400), [p])

    const r = await Effect.runPromise(personReadoutsProgram(p, NOW))
    expect(r).toEqual({
      today: '2026-10-05',
      lastContact: localDay(daysAgo(1)),
      lastEmail: localDay(daysAgo(10)),
      firstContact: localDay(daysAgo(400)),
    })
  })

  it('reads an email-only history as all three from the same day', async () => {
    const p = await aPerson('Only Email')
    await interact('email', daysAgo(3), [p])

    const r = await Effect.runPromise(personReadoutsProgram(p, NOW))
    expect(r.lastContact).toBe(localDay(daysAgo(3)))
    expect(r.lastEmail).toBe(localDay(daysAgo(3)))
    expect(r.firstContact).toBe(localDay(daysAgo(3)))
  })

  it('has no email date when nothing was an email', async () => {
    const p = await aPerson('Calls Only')
    await interact('call', daysAgo(2), [p])

    const r = await Effect.runPromise(personReadoutsProgram(p, NOW))
    expect(r.lastContact).toBe(localDay(daysAgo(2)))
    expect(r.lastEmail).toBeNull()
  })

  it('reads null, not zero, for a person with no interactions', async () => {
    const p = await aPerson('Never Met')
    const r = await Effect.runPromise(personReadoutsProgram(p, NOW))
    expect(r).toEqual({
      today: '2026-10-05',
      lastContact: null,
      lastEmail: null,
      firstContact: null,
    })
  })
})

describe('company readouts', () => {
  it('reads last contact through the company and its Team', async () => {
    const c = await aCompany('Teamed')
    const member = await aPerson('Team Member')
    const stranger = await aPerson('Stranger')
    await Effect.runPromise(
      setPersonCompanyProgram({
        personId: member,
        companyId: c,
        action: 'link',
        actor: ME,
      }),
    )
    await interact('email', daysAgo(9), [c])
    await interact('meeting', daysAgo(2), [member])
    await interact('call', daysAgo(1), [stranger])

    const r = await Effect.runPromise(companyReadoutsProgram(c, NOW))
    expect(r.lastContact).toBe(localDay(daysAgo(2)))
  })

  it('counts signals on the company in the last 30 days', async () => {
    const c = await aCompany('Moving')
    const other = await aCompany('Elsewhere')
    await db.insert(signal).values([
      { entityId: c, source: 'news', payload: {}, observedAt: daysAgo(2) },
      { entityId: c, source: 'hire', payload: {}, observedAt: daysAgo(29) },
      { entityId: c, source: 'old', payload: {}, observedAt: daysAgo(31) },
      { entityId: other, source: 'news', payload: {}, observedAt: daysAgo(1) },
    ])

    const r = await Effect.runPromise(companyReadoutsProgram(c, NOW))
    expect(r.moving30).toBe(2)
  })

  it('reads ownership from the holding ledger, null when not held', async () => {
    const held = await aCompany('Held')
    const notHeld = await aCompany('NotHeld')
    const h = (
      await db
        .insert(holding)
        .values({
          companyId: held,
          openedAt: '2025-01-01',
          createdBy: FIXTURE_ACTOR.id,
        })
        .returning({ id: holding.id })
    ).at(0)
    if (!h) throw new Error('no holding')
    await db.insert(investment).values({
      holdingId: h.id,
      date: '2025-01-01',
      amount: '100000',
      currency: 'USD',
      instrument: 'priced',
      shares: '50000',
    })
    await db.insert(round).values({
      companyId: held,
      date: '2025-01-01',
      kind: 'seed',
      sharesOutstanding: '1000000',
    })

    const r = await Effect.runPromise(companyReadoutsProgram(held, NOW))
    expect(r.ownership).toEqual({ kind: 'actual', pct: 0.05 })
    const none = await Effect.runPromise(companyReadoutsProgram(notHeld, NOW))
    expect(none.ownership).toBeNull()
  })

  it('reads dashes and a zero count for a quiet company', async () => {
    const c = await aCompany('Quiet')
    const r = await Effect.runPromise(companyReadoutsProgram(c, NOW))
    expect(r).toEqual({
      today: '2026-10-05',
      lastContact: null,
      moving30: 0,
      ownership: null,
    })
  })
})

describe('deal readouts', () => {
  it('reads last contact through its company and people (D49)', async () => {
    const c = await aCompany('DealCo')
    const p = await aPerson('Deal Contact')
    const outsider = await aPerson('Outsider')
    const viaCompany = await aDeal(c)
    const viaPerson = await aDeal(c, { people: [p] })
    await interact('email', daysAgo(6), [c])
    await interact('meeting', daysAgo(3), [p])
    await interact('call', daysAgo(1), [outsider])

    const a = await Effect.runPromise(dealReadoutsProgram(viaCompany, NOW))
    expect(a.lastContact).toBe(localDay(daysAgo(6)))
    const b = await Effect.runPromise(dealReadoutsProgram(viaPerson, NOW))
    expect(b.lastContact).toBe(localDay(daysAgo(3)))
  })

  it('reads null last contact when nothing touched the deal', async () => {
    const c = await aCompany('Silent')
    const d = await aDeal(c)
    const r = await Effect.runPromise(dealReadoutsProgram(d, NOW))
    expect(r.lastContact).toBeNull()
  })

  it('turns past twice the stage median, and not before', async () => {
    const c = await aCompany('Staged')
    // A stage of their own: the median is over every live deal in it.
    const fresh = await aDeal(c, {}, 'term_sheet')
    const median = await aDeal(c, {}, 'term_sheet')
    const stale = await aDeal(c, {}, 'term_sheet')
    await enteredStage(fresh, daysAgo(3))
    await enteredStage(median, daysAgo(4))
    await enteredStage(stale, daysAgo(20))

    const s = await Effect.runPromise(dealReadoutsProgram(stale, NOW))
    expect(s.daysInStage).toBe(20)
    expect(s.medianDaysInStage).toBeCloseTo(4)
    expect(s.pastTwiceMedian).toBe(true)

    const f = await Effect.runPromise(dealReadoutsProgram(fresh, NOW))
    expect(f.daysInStage).toBe(3)
    expect(f.pastTwiceMedian).toBe(false)
  })
})

describe('custom record readouts', () => {
  it('reads its own interactions and signals', async () => {
    const obj = (
      await db
        .insert(objectDef)
        .values({ slug: 'funds', singular: 'Fund', plural: 'Funds' })
        .returning({ id: objectDef.id })
    ).at(0)
    if (!obj) throw new Error('no object')
    const rec = (
      await db
        .insert(entity)
        .values({ kind: 'custom', objectId: obj.id, canonicalName: 'Fund I' })
        .returning({ id: entity.id })
    ).at(0)
    if (!rec) throw new Error('no record')
    await interact('meeting', daysAgo(13), [rec.id])
    await db.insert(signal).values([
      {
        entityId: rec.id,
        source: 'news',
        payload: {},
        observedAt: daysAgo(5),
      },
    ])

    const r = await Effect.runPromise(recordReadoutsProgram(rec.id, NOW))
    expect(r).toEqual({
      today: '2026-10-05',
      lastContact: localDay(daysAgo(13)),
      moving30: 1,
    })
  })
})
