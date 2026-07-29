import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { valueValidator } from './registry'
import { cleanupTestEntities } from '../entities/test-helpers'

describe('valueValidator', () => {
  it('validates select against options', () => {
    const def = {
      type: 'select' as const,
      options: { options: [{ id: 'seed', label: 'Seed' }] },
    }
    expect(valueValidator(def).safeParse('seed').success).toBe(true)
    expect(valueValidator(def).safeParse('ipo').success).toBe(false)
  })
  it('validates rating bounds from options', () => {
    const def = { type: 'rating' as const, options: { max: 5 } }
    expect(valueValidator(def).safeParse(5).success).toBe(true)
    expect(valueValidator(def).safeParse(6).success).toBe(false)
  })
  it('validates date shape', () => {
    const def = { type: 'date' as const, options: {} }
    expect(valueValidator(def).safeParse('2026-07-30').success).toBe(true)
    expect(valueValidator(def).safeParse('30/07/2026').success).toBe(false)
  })
  it('multi record_reference wants uuid arrays', () => {
    const def = {
      type: 'record_reference' as const,
      options: { multi: true },
    }
    expect(valueValidator(def).safeParse([randomUUID()]).success).toBe(true)
    expect(valueValidator(def).safeParse(randomUUID()).success).toBe(false)
  })
})

const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('setValues', () => {
  afterAll(async () => {
    await cleanupTestEntities([
      '^(ValCo|ValDeal|ValPerson) [0-9a-f]{4,8}( .*)?$',
    ])
  })

  it('writes values, events, and reference links in one pass', async () => {
    const { resolveEntity } = await import('../entities/resolve')
    const { setValues, AttributeValidationError } = await import('./values')
    const { db } = await import('#/db')
    const { attributeEvent, entity, link } = await import('#/db/schema')
    const { user } = await import('#/db/schema/auth')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)

    const co = await resolveEntity({
      kind: 'company',
      name: `ValCo ${tag}`,
      source: 'manual',
    })

    // Plain values + validation failure
    await setValues({
      entityId: co.entityId,
      patch: { funding_stage: 'seed', location: 'Bengaluru', founded_year: 2021 },
      actorId: actor.id,
    })
    await expect(
      setValues({
        entityId: co.entityId,
        patch: { funding_stage: 'not_a_stage' },
        actorId: actor.id,
      }),
    ).rejects.toThrow(AttributeValidationError)

    const [ent] = await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, co.entityId))
    expect(ent.values).toMatchObject({
      funding_stage: 'seed',
      location: 'Bengaluru',
      founded_year: 2021,
    })

    const events = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, co.entityId))
    expect(events.length).toBe(3)

    // A deal referencing the company materializes a link
    const [dealEnt] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: `ValDeal ${tag}` })
      .returning({ id: entity.id })
    await setValues({
      entityId: dealEnt.id,
      patch: { stage: 'pre_lead', company: co.entityId },
      actorId: actor.id,
    })
    const refLinks = await db
      .select()
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, dealEnt.id),
          eq(link.relation, 'references'),
          eq(link.attrSlug, 'company'),
        ),
      )
    expect(refLinks.length).toBe(1)
    expect(refLinks[0].toEntityId).toBe(co.entityId)

    // Clearing a required reference is rejected
    await expect(
      setValues({
        entityId: dealEnt.id,
        patch: { company: null },
        actorId: actor.id,
      }),
    ).rejects.toThrow(/Required/)

    // Wrong-kind reference is rejected
    await expect(
      setValues({
        entityId: dealEnt.id,
        patch: { company: dealEnt.id },
        actorId: actor.id,
      }),
    ).rejects.toThrow(/Must reference a company/)

    // No-op patch writes no events
    const before = events.length
    await setValues({
      entityId: co.entityId,
      patch: { location: 'Bengaluru' },
      actorId: actor.id,
    })
    const after = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, co.entityId))
    expect(after.length).toBe(before)
  })
})
