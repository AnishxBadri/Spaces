import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { valueValidator } from './registry'
import type { AttributeDef, AttributeOptions, AttributeType } from './registry'
import type { Json } from '#/lib/json'
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

  it('rejects an archived option with a clear message unless already held', () => {
    const options = {
      options: [
        { id: 'seed', label: 'Seed' },
        { id: 'angel', label: 'Angel round', archived: true },
      ],
    }
    const select = { type: 'select' as const, options }
    const fresh = valueValidator(select).safeParse('angel')
    expect(fresh.success).toBe(false)
    expect(fresh.error?.issues[0]?.message).toBe(
      '"Angel round" is archived — pick a current option',
    )
    expect(valueValidator(select).safeParse('seed').success).toBe(true)
    // Re-asserting what the record already holds is not a new assertion.
    expect(valueValidator(select, 'angel').safeParse('angel').success).toBe(
      true,
    )

    const multi = { type: 'multi_select' as const, options }
    expect(valueValidator(multi).safeParse(['seed', 'angel']).success).toBe(
      false,
    )
    // A multi-select gaining a tag keeps its retired one.
    expect(
      valueValidator(multi, ['angel']).safeParse(['angel', 'seed']).success,
    ).toBe(true)
  })
})

describe('planPatch (pure)', () => {
  const def = (type: 'text' | 'checkbox', slug: string, required: boolean) =>
    ({
      id: slug,
      objectId: 'o',
      slug,
      name: slug,
      type,
      options: { required },
      isSystem: false,
      archived: false,
      sortOrder: 0,
    }) as const

  it('rejects clearing a required value, any type', async () => {
    const { Effect } = await import('effect')
    const { planPatch, AttributeValidationError } = await import('./values')
    const registry = [
      def('text', 'thesis', true),
      def('checkbox', 'lead', true),
    ]
    for (const [slug, held] of [
      ['thesis', 'x'],
      ['lead', true],
    ] as const) {
      const run = () =>
        Effect.runSync(planPatch(registry, { [slug]: held }, { [slug]: null }))
      expect(run).toThrow(AttributeValidationError)
      expect(run).toThrow(/can't be cleared/)
    }
  })

  it('keeps a held archived value across unrelated writes, rejects asserting one', async () => {
    const { Effect } = await import('effect')
    const { planPatch, AttributeValidationError } = await import('./values')
    const retired: AttributeDef['options'] = {
      options: [
        { id: 'seed', label: 'Seed' },
        { id: 'angel', label: 'Angel', archived: true },
      ],
    }
    const registry: Array<AttributeDef> = [
      def('text', 'thesis', false),
      { ...def('text', 'tags', false), type: 'multi_select', options: retired },
      { ...def('text', 'stage', false), type: 'select', options: retired },
    ]
    const current = { tags: ['angel'], stage: 'angel' }

    // Unrelated key: the archived values are not in the patch, so they
    // are neither validated nor cleared.
    expect(
      Effect.runSync(planPatch(registry, current, { thesis: 'x' })),
    ).toMatchObject([{ slug: 'thesis', value: 'x' }])

    // Adding a live tag next to a held archived one is fine.
    expect(
      Effect.runSync(planPatch(registry, current, { tags: ['angel', 'seed'] })),
    ).toMatchObject([{ slug: 'tags', value: ['angel', 'seed'] }])

    // Asserting the archived option afresh is rejected, slug-prefixed.
    const run = () =>
      Effect.runSync(planPatch(registry, { stage: 'seed' }, { stage: 'angel' }))
    expect(run).toThrow(AttributeValidationError)
    expect(run).toThrow('stage: "Angel" is archived — pick a current option')
  })

  it('treats clearing an already-empty required value as a no-op', async () => {
    const { Effect } = await import('effect')
    const { planPatch } = await import('./values')
    const registry = [def('text', 'thesis', true)]
    // Born without the value (creation completeness is the dialog's job);
    // an explicit null later has nothing to clear.
    expect(Effect.runSync(planPatch(registry, {}, { thesis: null }))).toEqual(
      [],
    )
    expect(
      Effect.runSync(planPatch(registry, {}, { thesis: 'now set' })),
    ).toMatchObject([{ slug: 'thesis', before: null, value: 'now set' }])
  })
})

const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('required means can’t-clear (all types)', () => {
  const tag = randomUUID().slice(0, 8)
  const slug = (t: string) => `req_${t}_${tag}`

  afterAll(async () => {
    const { db } = await import('#/db')
    const { attribute } = await import('#/db/schema')
    const { like } = await import('drizzle-orm')
    await cleanupTestEntities([`^ReqCo ${tag}$`])
    await db.delete(attribute).where(like(attribute.slug, `req_%_${tag}`))
  })

  it('rejects an explicit clear per type family, allows born-empty', async () => {
    const { resolveEntity } = await import('../entities/resolve')
    const { setValues, AttributeValidationError } = await import('./values')
    const { objectIdForKindAsync } = await import('./objects')
    const { db } = await import('#/db')
    const { attribute } = await import('#/db/schema')
    const { user } = await import('#/db/schema/auth')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const objectId = await objectIdForKindAsync('company')

    // One required custom attribute per type family, on the company object.
    const families: Array<{
      type: AttributeType
      held: Json
      options: AttributeOptions
    }> = [
      { type: 'text', held: 'thesis', options: {} },
      { type: 'number', held: 7, options: {} },
      { type: 'date', held: '2026-01-01', options: {} },
      { type: 'checkbox', held: true, options: {} },
      { type: 'rating', held: 3, options: { max: 5 } },
      {
        type: 'select',
        held: 'a',
        options: { options: [{ id: 'a', label: 'A' }] },
      },
      {
        type: 'multi_select',
        held: ['a'],
        options: { options: [{ id: 'a', label: 'A' }] },
      },
    ]
    await db.insert(attribute).values(
      families.map((f) => ({
        objectId,
        slug: slug(f.type),
        name: `Req ${f.type}`,
        type: f.type,
        options: { ...f.options, required: true },
      })),
    )

    // Born without any of them: legal (creation completeness is the
    // dialog's concern, imports create partial records).
    const co = await resolveEntity({
      kind: 'company',
      name: `ReqCo ${tag}`,
      source: 'manual',
    })
    const actorArg = { type: 'user' as const, id: actor.id }

    // Later non-null writes work; the clear is what's rejected.
    for (const f of families) {
      await setValues({
        entityId: co.entityId,
        patch: { [slug(f.type)]: f.held },
        actor: actorArg,
      })
      await expect(
        setValues({
          entityId: co.entityId,
          patch: { [slug(f.type)]: null },
          actor: actorArg,
        }),
      ).rejects.toThrow(AttributeValidationError)
      await expect(
        setValues({
          entityId: co.entityId,
          patch: { [slug(f.type)]: '' },
          actor: actorArg,
        }),
      ).rejects.toThrow(/can't be cleared/)
    }
  })
})

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
      patch: {
        funding_stage: 'seed',
        location: 'Bengaluru',
        founded_year: 2021,
      },
      actor: { type: 'user', id: actor.id },
    })
    await expect(
      setValues({
        entityId: co.entityId,
        patch: { funding_stage: 'not_a_stage' },
        actor: { type: 'user', id: actor.id },
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

    // Only this test's own writes: another suite may hold custom attributes
    // with defaults on the company object at the same moment, and those
    // fire at birth (SPA-9), so the row count alone is not ours to assert.
    const events = (
      await db
        .select()
        .from(attributeEvent)
        .where(eq(attributeEvent.entityId, co.entityId))
    ).filter((e) =>
      ['funding_stage', 'location', 'founded_year'].includes(e.attrSlug),
    )
    expect(events.length).toBe(3)
    // A direct human edit: typed actor + default door, no receipt.
    for (const ev of events) {
      expect(ev.actorType).toBe('user')
      expect(ev.actorId).toBe(actor.id)
      expect(ev.source).toBe('direct')
      expect(ev.suggestionId).toBeNull()
      expect(ev.refs).toBeNull()
    }

    // A deal referencing the company materializes a link
    const [dealEnt] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: `ValDeal ${tag}` })
      .returning({ id: entity.id })
    await setValues({
      entityId: dealEnt.id,
      patch: { stage: 'pre_lead', company: co.entityId },
      actor: { type: 'user', id: actor.id },
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
        actor: { type: 'user', id: actor.id },
      }),
    ).rejects.toThrow(/Required/)

    // Wrong-kind reference is rejected
    await expect(
      setValues({
        entityId: dealEnt.id,
        patch: { company: dealEnt.id },
        actor: { type: 'user', id: actor.id },
      }),
    ).rejects.toThrow(/Must reference a company/)

    // No-op patch writes no events
    const before = events.length
    await setValues({
      entityId: co.entityId,
      patch: { location: 'Bengaluru' },
      actor: { type: 'user', id: actor.id },
    })
    const after = (
      await db
        .select()
        .from(attributeEvent)
        .where(eq(attributeEvent.entityId, co.entityId))
    ).filter((e) =>
      ['funding_stage', 'location', 'founded_year'].includes(e.attrSlug),
    )
    expect(after.length).toBe(before)
  })

  it('carries provenance on the event row and honours non-user actors', async () => {
    const { resolveEntity } = await import('../entities/resolve')
    const { setValues } = await import('./values')
    const { db } = await import('#/db')
    const { attributeEvent } = await import('#/db/schema')
    const { user } = await import('#/db/schema/auth')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const co = await resolveEntity({
      kind: 'company',
      name: `ValCo ${tag}`,
      source: 'manual',
    })

    // Accepting a suggestion: the accepter is the actor, the receipt rides
    // the event — "from p.4 of the deck" survives acceptance.
    const suggestionId = randomUUID()
    await setValues({
      entityId: co.entityId,
      patch: { location: 'Pune' },
      actor: { type: 'user', id: actor.id },
      source: 'suggestion',
      suggestionId,
      refs: ['doc:abc#chunk:4'],
    })
    const [accepted] = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, co.entityId),
          eq(attributeEvent.attrSlug, 'location'),
        ),
      )
    expect(accepted.actorType).toBe('user')
    expect(accepted.source).toBe('suggestion')
    expect(accepted.suggestionId).toBe(suggestionId)
    expect(accepted.refs).toEqual(['doc:abc#chunk:4'])

    // A system write has no user FK; the check constraint holds the invariant.
    await setValues({
      entityId: co.entityId,
      patch: { founded_year: 2019 },
      actor: { type: 'system' },
      source: 'seed',
    })
    const [sys] = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, co.entityId),
          eq(attributeEvent.attrSlug, 'founded_year'),
        ),
      )
    expect(sys.actorType).toBe('system')
    expect(sys.actorId).toBeNull()
    expect(sys.source).toBe('seed')
  })
})
