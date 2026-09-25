import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Json } from '#/lib/json'
import type { Decider } from './propose'

/**
 * The suggestion table end to end (SPA-46): propose writes a row and no
 * value; accept writes the value through the one write path with the
 * accepter as actor and the row as the receipt; a payload the registry no
 * longer holds leaves the row open; two racing accepts write once.
 */

async function setup() {
  const { resolveEntity } = await import('#/lib/entities/resolve')
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const accepter = (
    await db.select({ id: user.id, name: user.name }).from(user).limit(1)
  ).at(0)
  if (!accepter) throw new Error('the test seed has no user')
  const tag = randomUUID().slice(0, 8)
  const company = await resolveEntity({
    kind: 'company',
    name: `Proposed ${tag}`,
    keys: { domain: `proposed-${tag}.example` },
    source: { class: 'manual' },
  })
  return { accepter, entityId: company.entityId }
}

describe('propose → accept', () => {
  it('writes the value as the accepter, with the suggestion as the receipt', async () => {
    const { Effect } = await import('effect')
    const { proposeProgram, acceptProgram } = await import('./propose')
    const { recordTimelineProgram } = await import('#/lib/timeline/record')
    const { db } = await import('@spaces/db')
    const { attributeEvent, entity, suggestion } =
      await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { accepter, entityId } = await setup()

    const proposed = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'attribute_patch',
        payload: {
          founded_year: { value: 2019, refs: ['doc:deck#p2'], confidence: 0.8 },
          location: {
            value: 'Berlin',
            refs: ['doc:deck#p2', 'doc:deck#p9'],
            confidence: 0.6,
          },
        },
        rationale: 'Read off the deck',
        proposedBy: { type: 'system' },
      }),
    )
    expect(proposed.status).toBe('open')
    // The suggestion's refs are the union of the per-field refs.
    expect(proposed.refs).toEqual(['doc:deck#p2', 'doc:deck#p9'])

    // Proposing wrote nothing to the record.
    const before = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0)
    expect(before?.values.founded_year).toBeUndefined()
    expect(
      await db
        .select()
        .from(attributeEvent)
        .where(eq(attributeEvent.entityId, entityId)),
    ).toEqual([])

    const accepted = await Effect.runPromise(
      acceptProgram(proposed.id, { type: 'user', id: accepter.id }),
    )
    if (accepted.kind !== 'attribute_patch') throw new Error('not a patch')
    expect(accepted.write.changed.sort()).toEqual(['founded_year', 'location'])

    const after = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0)
    expect(after?.values.founded_year).toBe(2019)
    expect(after?.values.location).toBe('Berlin')

    const events = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, entityId))
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e.actorType).toBe('user')
      expect(e.actorId).toBe(accepter.id)
      expect(e.source).toBe('suggestion')
      expect(e.suggestionId).toBe(proposed.id)
      expect(e.refs).toEqual(['doc:deck#p2', 'doc:deck#p9'])
    }

    const row = (
      await db.select().from(suggestion).where(eq(suggestion.id, proposed.id))
    ).at(0)
    expect(row?.status).toBe('accepted')
    expect(row?.decidedBy).toBe(accepter.id)
    expect(row?.decidedAt).toBeInstanceOf(Date)

    // The record timeline shows the change as the accepter's, not a machine's.
    const timeline = await Effect.runPromise(recordTimelineProgram(entityId))
    const burst = timeline.find((i) => i.type === 'attrs')
    expect(burst).toMatchObject({
      actorType: 'user',
      actorName: accepter.name,
      source: 'suggestion',
    })
  })

  it('leaves the row open and says why when the payload no longer validates', async () => {
    const { Effect } = await import('effect')
    const {
      proposeProgram,
      acceptProgram,
      SuggestionInvalid,
      suggestionMessage,
    } = await import('./propose')
    const { db } = await import('@spaces/db')
    const { attribute, attributeEvent, suggestion } =
      await import('@spaces/db/schema')
    const { objectIdForKindAsync } = await import('#/lib/attributes/objects')
    const { and, eq } = await import('drizzle-orm')
    const { accepter, entityId } = await setup()

    const proposed = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'attribute_patch',
        payload: {
          location: { value: 'Lisbon', refs: [], confidence: 0.5 },
        },
        proposedBy: { type: 'user', id: accepter.id },
      }),
    )

    // The registry moves between propose and accept.
    const companyObject = await objectIdForKindAsync('company')
    const where = and(
      eq(attribute.objectId, companyObject),
      eq(attribute.slug, 'location'),
    )
    await db.update(attribute).set({ archived: true }).where(where)
    try {
      const failure = await Effect.runPromise(
        Effect.flip(
          acceptProgram(proposed.id, { type: 'user', id: accepter.id }),
        ),
      )
      expect(failure).toBeInstanceOf(SuggestionInvalid)
      // The validator's own `slug: detail`, not a generic sentence.
      expect(suggestionMessage(failure)).toBe('location: Unknown attribute')
    } finally {
      await db.update(attribute).set({ archived: false }).where(where)
    }

    const row = (
      await db.select().from(suggestion).where(eq(suggestion.id, proposed.id))
    ).at(0)
    expect(row?.status).toBe('open')
    expect(row?.decidedBy).toBeNull()
    expect(
      await db
        .select()
        .from(attributeEvent)
        .where(eq(attributeEvent.entityId, entityId)),
    ).toEqual([])
  })

  it('refuses an invalid payload at propose with the validator message', async () => {
    const { Effect } = await import('effect')
    const { proposeProgram, suggestionMessage } = await import('./propose')
    const { entityId } = await setup()

    const failure = await Effect.runPromise(
      Effect.flip(
        proposeProgram({
          entityId,
          kind: 'attribute_patch',
          payload: {
            founded_year: { value: 'last year', refs: [], confidence: 1 },
          },
          proposedBy: { type: 'system' },
        }),
      ),
    )
    expect(suggestionMessage(failure)).toMatch(/^founded_year: /)
  })

  it('writes once when two accepts race', async () => {
    const { Effect } = await import('effect')
    const { proposeProgram, acceptProgram, SuggestionNotOpen } =
      await import('./propose')
    const { db } = await import('@spaces/db')
    const { attributeEvent } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { accepter, entityId } = await setup()

    const proposed = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'attribute_patch',
        payload: {
          description: { value: 'Rockets', refs: ['doc:x'], confidence: 0.9 },
        },
        proposedBy: { type: 'system' },
      }),
    )
    const accept = () =>
      Effect.runPromise(
        Effect.result(
          acceptProgram(proposed.id, { type: 'user', id: accepter.id }),
        ),
      )
    const results = await Promise.all([accept(), accept()])

    const wins = results.filter((r) => r._tag === 'Success')
    const losses = results.flatMap((r) => (r._tag === 'Failure' ? [r] : []))
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(1)
    expect(losses[0]?.failure).toBeInstanceOf(SuggestionNotOpen)

    const events = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, entityId))
    expect(events).toHaveLength(1)
  })

  it('refuses kinds with no accept path, and closes on reject', async () => {
    const { Effect } = await import('effect')
    const {
      proposeProgram,
      acceptProgram,
      rejectProgram,
      UnsupportedSuggestionKind,
      SuggestionNotOpen,
    } = await import('./propose')
    const { accepter, entityId } = await setup()
    const decider: Decider = { type: 'user', id: accepter.id }

    // `ledger_event` has no accept path yet (`note` gained one in SPA-66).
    const ledger = await Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'ledger_event',
        payload: { kind: 'mark', fairValue: 1000 },
        proposedBy: { type: 'system' },
      }),
    )
    const refused = await Effect.runPromise(
      Effect.flip(acceptProgram(ledger.id, decider)),
    )
    expect(refused).toBeInstanceOf(UnsupportedSuggestionKind)

    const rejected = await Effect.runPromise(rejectProgram(ledger.id, decider))
    expect(rejected.status).toBe('rejected')
    expect(rejected.decidedBy).toBe(accepter.id)

    const again = await Effect.runPromise(
      Effect.flip(acceptProgram(ledger.id, decider)),
    )
    expect(again).toBeInstanceOf(SuggestionNotOpen)
  })
})

/**
 * SPA-110 — bulk accept. Each item goes through `acceptProgram` in its own
 * transaction; one bad field is one failed item, never an aborted batch.
 */
describe('bulk accept', () => {
  const FIVE: Json = {
    description: { value: 'Batteries', refs: ['doc:deck#p1'], confidence: 1 },
    location: { value: 'Oslo', refs: ['doc:deck#p1'], confidence: 1 },
    founded_year: { value: 2021, refs: ['doc:deck#p2'], confidence: 1 },
    funding_stage: { value: 'seed', refs: ['doc:deck#p3'], confidence: 1 },
    business_model: { value: ['b2b'], refs: ['doc:deck#p3'], confidence: 1 },
  }

  /** Archive the `seed` option of `funding_stage`; returns the undo. */
  async function archiveSeed() {
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { objectIdForKindAsync } = await import('#/lib/attributes/objects')
    const { and, eq } = await import('drizzle-orm')
    const where = and(
      eq(attribute.objectId, await objectIdForKindAsync('company')),
      eq(attribute.slug, 'funding_stage'),
    )
    const def = (await db.select().from(attribute).where(where)).at(0)
    if (!def) throw new Error('no funding_stage attribute')
    await db
      .update(attribute)
      .set({
        options: {
          ...def.options,
          options: (def.options.options ?? []).map((o) =>
            o.id === 'seed' ? { ...o, archived: true } : o,
          ),
        },
      })
      .where(where)
    return async () => {
      await db.update(attribute).set({ options: def.options }).where(where)
    }
  }

  async function propose(entityId: string, payload: Json) {
    const { Effect } = await import('effect')
    const { proposeProgram } = await import('./propose')
    return Effect.runPromise(
      proposeProgram({
        entityId,
        kind: 'attribute_patch',
        payload,
        proposedBy: { type: 'system' },
      }),
    )
  }

  async function rowOf(id: string) {
    const { db } = await import('@spaces/db')
    const { suggestion } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    return (await db.select().from(suggestion).where(eq(suggestion.id, id))).at(
      0,
    )
  }

  async function valuesOf(entityId: string) {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    return (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, entityId))
    ).at(0)?.values
  }

  const keysOf = (payload: Json | undefined) =>
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload)
      : []

  it('accepts a record field by field: four land, the archived option fails and stays open', async () => {
    const { Effect } = await import('effect')
    const { acceptRecordProgram } = await import('./propose')
    const { accepter, entityId } = await setup()
    const proposed = await propose(entityId, FIVE)

    const restore = await archiveSeed()
    try {
      const outcomes = await Effect.runPromise(
        acceptRecordProgram({ entityId, actorId: accepter.id }),
      )
      expect(outcomes).toHaveLength(5)
      expect(outcomes.filter((o) => o.ok)).toHaveLength(4)
      const failed = outcomes.flatMap((o) => (o.ok ? [] : [o]))
      expect(failed).toHaveLength(1)
      expect(failed[0]?.suggestionId).toBe(proposed.id)
      expect(failed[0]?.slug).toBe('funding_stage')
      // The validator's own `slug: detail`, not a generic sentence.
      expect(failed[0]?.message).toMatch(/^funding_stage: /)
    } finally {
      await restore()
    }

    const values = await valuesOf(entityId)
    expect(values?.description).toBe('Batteries')
    expect(values?.location).toBe('Oslo')
    expect(values?.founded_year).toBe(2021)
    expect(values?.business_model).toEqual(['b2b'])
    expect(values?.funding_stage).toBeUndefined()

    // The rule: a row with a field left stays open, holding only that field.
    const row = await rowOf(proposed.id)
    expect(row?.status).toBe('open')
    expect(row?.decidedBy).toBeNull()
    expect(keysOf(row?.payload)).toEqual(['funding_stage'])

    // Once the option is live again, the last field closes the row.
    const again = await Effect.runPromise(
      acceptRecordProgram({ entityId, actorId: accepter.id }),
    )
    expect(again).toEqual([
      { suggestionId: proposed.id, slug: 'funding_stage', ok: true },
    ])
    const closed = await rowOf(proposed.id)
    expect(closed?.status).toBe('accepted')
    expect(closed?.decidedBy).toBe(accepter.id)
  })

  it('accepts one column across three records, leaving the other fields open', async () => {
    const { Effect } = await import('effect')
    const { acceptColumnProgram } = await import('./propose')
    const records = [await setup(), await setup(), await setup()]
    const accepter = records[0].accepter
    const rows = []
    for (const [i, r] of records.entries())
      rows.push(
        await propose(r.entityId, {
          location: { value: `City ${i}`, refs: [], confidence: 1 },
          founded_year: { value: 2000 + i, refs: [], confidence: 1 },
        }),
      )
    // A suggestion that does not carry the column is not touched.
    const other = await propose(records[0].entityId, {
      description: { value: 'Untouched', refs: [], confidence: 1 },
    })

    const outcomes = await Effect.runPromise(
      acceptColumnProgram({ attributeSlug: 'location', actorId: accepter.id }),
    )
    // A column is global: an earlier test in this file may have left an open
    // `location` of its own, so read only this test's rows out of the batch.
    const ours = new Set(rows.map((r) => r.id))
    expect(outcomes.filter((o) => ours.has(o.suggestionId))).toEqual(
      rows.map((r) => ({ suggestionId: r.id, slug: 'location', ok: true })),
    )
    expect(outcomes.some((o) => o.suggestionId === other.id)).toBe(false)
    for (const [i, r] of records.entries()) {
      const values = await valuesOf(r.entityId)
      expect(values?.location).toBe(`City ${i}`)
      expect(values?.founded_year).toBeUndefined()
    }
    for (const r of rows) {
      const row = await rowOf(r.id)
      expect(row?.status).toBe('open')
      expect(keysOf(row?.payload)).toEqual(['founded_year'])
    }
    const untouched = await rowOf(other.id)
    expect(untouched?.status).toBe('open')
    expect(untouched?.payload).toEqual(other.payload)
  })

  it('leaves every suggestion open and reports each failure when all fail', async () => {
    const { Effect } = await import('effect')
    const { acceptColumnProgram } = await import('./propose')
    const a = await setup()
    const b = await setup()
    const rows = [
      await propose(a.entityId, {
        funding_stage: { value: 'seed', refs: [], confidence: 1 },
      }),
      await propose(b.entityId, {
        funding_stage: { value: 'seed', refs: [], confidence: 1 },
        location: { value: 'Rome', refs: [], confidence: 1 },
      }),
    ]
    const restore = await archiveSeed()
    try {
      const outcomes = await Effect.runPromise(
        acceptColumnProgram({
          attributeSlug: 'funding_stage',
          actorId: a.accepter.id,
        }),
      )
      expect(outcomes).toHaveLength(2)
      expect(outcomes.every((o) => !o.ok)).toBe(true)
    } finally {
      await restore()
    }
    for (const r of rows) {
      const row = await rowOf(r.id)
      expect(row?.status).toBe('open')
      expect(row?.payload).toEqual(r.payload)
    }
    expect((await valuesOf(b.entityId))?.location).toBeUndefined()
  })

  it('runs each item in its own transaction — items before and after a failure land', async () => {
    const { Effect } = await import('effect')
    const { vi } = await import('vitest')
    const { acceptRecordProgram } = await import('./propose')
    const { db } = await import('@spaces/db')
    const { accepter, entityId } = await setup()
    // Four suggestions, oldest first: the third's only field is refused.
    const first = await propose(entityId, {
      location: { value: 'Paris', refs: [], confidence: 1 },
    })
    const second = await propose(entityId, {
      founded_year: { value: 2018, refs: [], confidence: 1 },
    })
    const third = await propose(entityId, {
      funding_stage: { value: 'seed', refs: [], confidence: 1 },
    })
    const fourth = await propose(entityId, {
      description: { value: 'After', refs: [], confidence: 1 },
    })

    const restore = await archiveSeed()
    const spy = vi.spyOn(db, 'transaction')
    try {
      const outcomes = await Effect.runPromise(
        acceptRecordProgram({ entityId, actorId: accepter.id }),
      )
      expect(outcomes.map((o) => [o.suggestionId, o.ok])).toEqual([
        [first.id, true],
        [second.id, true],
        [third.id, false],
        [fourth.id, true],
      ])
      // One transaction per item, never one around the batch.
      expect(spy).toHaveBeenCalledTimes(4)
    } finally {
      spy.mockRestore()
      await restore()
    }
    const values = await valuesOf(entityId)
    expect(values?.location).toBe('Paris')
    expect(values?.founded_year).toBe(2018)
    expect(values?.description).toBe('After')
    expect((await rowOf(second.id))?.status).toBe('accepted')
    expect((await rowOf(third.id))?.status).toBe('open')
    expect((await rowOf(fourth.id))?.status).toBe('accepted')
  })
})
