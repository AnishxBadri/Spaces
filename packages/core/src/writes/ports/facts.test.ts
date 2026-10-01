import { Cause, Effect, Exit, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  attribute,
  attributeEvent,
  entity,
  integration,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { Facts, JobPermanent, Receipts } from '@spaces/sdk'
import type { FactClaim } from '@spaces/sdk'
import { Enqueue } from '../../queue/enqueue'
import { objectIdForKindAsync } from '../attributes/objects'
import { setValues } from '../attributes/values'
import { resolveEntity } from '../entities/resolve'
import { FactsLive } from './facts'
import { ReceiptsLive } from './receipts'

/**
 * Facts bound to an integration row (sdk-9), against a real database: fill
 * blanks only, the bound row as the actor, a person's value refused and
 * returned, this integration's own value updated, and the receipt it cites
 * checked to be its own — every refusal leaving nothing written.
 */

const EnqueueTest = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const boundRow = async (capabilityId = 'echo') => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '1.0.0', enabled: true })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const ports = (row: { id: string; capabilityId: string }) =>
  Layer.mergeAll(
    FactsLive(row).pipe(Layer.provide(EnqueueTest)),
    ReceiptsLive(row),
  )

const fillProgram = (claim: FactClaim) =>
  Effect.gen(function* () {
    return yield* (yield* Facts).fill(claim)
  })

const fill = (row: { id: string; capabilityId: string }, claim: FactClaim) =>
  Effect.runPromise(fillProgram(claim).pipe(Effect.provide(ports(row))))

const fillExit = (
  row: { id: string; capabilityId: string },
  claim: FactClaim,
) => Effect.runPromiseExit(fillProgram(claim).pipe(Effect.provide(ports(row))))

const store = (row: { id: string; capabilityId: string }, entityId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Receipts).store({
        entityId,
        raw: { headcount: 42 },
      })
    }).pipe(Effect.provide(ports(row))),
  )

const company = async (name: string) =>
  (await resolveEntity({ kind: 'company', name, source: { class: 'manual' } }))
    .entityId

const eventsFor = (entityId: string, slug?: string) =>
  db
    .select()
    .from(attributeEvent)
    .where(
      slug === undefined
        ? eq(attributeEvent.entityId, entityId)
        : and(
            eq(attributeEvent.entityId, entityId),
            eq(attributeEvent.attrSlug, slug),
          ),
    )

const valuesOf = async (entityId: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)?.values ?? {}

/** The failure a refused fill ends with — a typed JobError, never a defect. */
const permanentReason = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error('the fill succeeded')
  const error = Cause.squash(exit.cause)
  if (!(error instanceof JobPermanent))
    throw new Error(`not a JobPermanent: ${String(error)}`)
  return error.reason
}

const aUser = async () => {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('no fixture user')
  return row.id
}

describe('Facts.fill, bound to an integration row', () => {
  it('fills a blank: the integration is the actor, enrichment the door, the receipt the refs', async () => {
    const row = await boundRow()
    const co = await company('Blank Co')
    const { receiptId } = await store(row, co)

    const result = await fill(row, {
      entityId: co,
      values: { founded_year: 2015 },
      receiptId,
    })
    expect(result).toEqual({ conflicts: [] })
    expect((await valuesOf(co)).founded_year).toBe(2015)

    const events = await eventsFor(co, 'founded_year')
    expect(events).toHaveLength(1)
    expect(events.at(0)).toMatchObject({
      actorType: 'integration',
      actorRef: row.id,
      actorId: null,
      source: 'enrichment',
      from: null,
      to: 2015,
      refs: [`event:${receiptId}`],
    })
  })

  it('refuses a value a person set: returned as a conflict, no event written', async () => {
    const row = await boundRow()
    const co = await company('Human Co')
    await setValues({
      entityId: co,
      patch: { founded_year: 1990 },
      actor: { type: 'user', id: await aUser() },
    })

    const result = await fill(row, {
      entityId: co,
      values: { founded_year: 2015, location: 'Bengaluru' },
    })
    expect(result.conflicts).toEqual([
      { slug: 'founded_year', existing: 1990, proposed: 2015 },
    ])
    // The blank beside it still fills: a conflict refuses one slug, not the claim.
    expect(await valuesOf(co)).toMatchObject({
      founded_year: 1990,
      location: 'Bengaluru',
    })
    const years = await eventsFor(co, 'founded_year')
    expect(years).toHaveLength(1)
    expect(years.at(0)?.actorType).toBe('user')
  })

  it('updates in place a value the same integration filled before (machine over machine is a fill)', async () => {
    const row = await boundRow()
    const co = await company('Twice Co')
    await fill(row, { entityId: co, values: { founded_year: 2015 } })

    const result = await fill(row, {
      entityId: co,
      values: { founded_year: 2016 },
    })
    expect(result.conflicts).toEqual([])
    expect((await valuesOf(co)).founded_year).toBe(2016)
    const events = await eventsFor(co, 'founded_year')
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.actorRef === row.id)).toBe(true)
  })

  it("refuses another integration's value: one provider never overwrites another", async () => {
    const first = await boundRow('apollo')
    const second = await boundRow('pdl')
    const co = await company('Two Providers Co')
    await fill(first, { entityId: co, values: { founded_year: 2015 } })

    const result = await fill(second, {
      entityId: co,
      values: { founded_year: 2014 },
    })
    expect(result.conflicts).toEqual([
      { slug: 'founded_year', existing: 2015, proposed: 2014 },
    ])
    expect(await eventsFor(co, 'founded_year')).toHaveLength(1)
  })

  it('fails permanently on a value the registry refuses, and writes nothing of the claim', async () => {
    const row = await boundRow()
    const co = await company('Invalid Co')

    const exit = await fillExit(row, {
      entityId: co,
      values: { location: 'Pune', founded_year: 'not a year' },
    })
    expect(permanentReason(exit)).toMatch(/^Facts\.fill: founded_year:/)
    expect(await valuesOf(co)).not.toHaveProperty('location')
    expect(await eventsFor(co)).toHaveLength(0)
  })

  it("refuses an empty value for a required attribute as a clear (required means can't-clear)", async () => {
    const row = await boundRow()
    await db.insert(attribute).values({
      objectId: await objectIdForKindAsync('company'),
      slug: 'fill_required_thesis',
      name: 'Thesis',
      type: 'text',
      options: { required: true },
    })
    const co = await company('Required Co')
    await fill(row, {
      entityId: co,
      values: { fill_required_thesis: 'climate' },
    })

    const exit = await fillExit(row, {
      entityId: co,
      values: { fill_required_thesis: '', location: 'Pune' },
    })
    expect(permanentReason(exit)).toMatch(/can't be cleared/)
    expect(await valuesOf(co)).toMatchObject({
      fill_required_thesis: 'climate',
    })
    expect(await valuesOf(co)).not.toHaveProperty('location')
    expect(await eventsFor(co, 'fill_required_thesis')).toHaveLength(1)
  })

  it('refuses a receipt another integration stored, writing nothing', async () => {
    const mine = await boundRow('apollo')
    const theirs = await boundRow('pdl')
    const co = await company('Borrowed Receipt Co')
    const { receiptId } = await store(theirs, co)

    const exit = await fillExit(mine, {
      entityId: co,
      values: { founded_year: 2015 },
      receiptId,
    })
    expect(permanentReason(exit)).toMatch(/another integration/)
    expect(await valuesOf(co)).not.toHaveProperty('founded_year')
    expect(await eventsFor(co)).toHaveLength(0)

    // Its own receipt is accepted for the same claim.
    const own = await store(mine, co)
    const result = await fill(mine, {
      entityId: co,
      values: { founded_year: 2015 },
      receiptId: own.receiptId,
    })
    expect(result.conflicts).toEqual([])
  })

  it('refuses a receipt that does not exist', async () => {
    const row = await boundRow()
    const co = await company('Ghost Receipt Co')
    const exit = await fillExit(row, {
      entityId: co,
      values: { founded_year: 2015 },
      receiptId: '00000000-0000-4000-8000-000000000000',
    })
    expect(permanentReason(exit)).toMatch(/no receipt/)
    expect(await eventsFor(co)).toHaveLength(0)
  })
})
