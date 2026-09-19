import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest'
import { cleanupTestEntities } from '../entities/test-helpers'
import type { AttributeConfigPatch, UpdateAttributePatch } from './update'

// ---------------------------------------------------------------------------
// Type-level: the §3 immutables are absent from the patch, not rejected.
// ---------------------------------------------------------------------------

describe('UpdateAttributePatch shape', () => {
  it('has no type or slug', () => {
    expectTypeOf<UpdateAttributePatch>().not.toHaveProperty('type')
    expectTypeOf<UpdateAttributePatch>().not.toHaveProperty('slug')
    // @ts-expect-error type is not an editable field
    const _type: UpdateAttributePatch = { id: 'x', type: 'text' }
    // @ts-expect-error slug is not an editable field
    const _slug: UpdateAttributePatch = { id: 'x', slug: 'renamed' }
    void _type
    void _slug
  })

  it('has no record_reference targetKind or multi in config', () => {
    type Config = NonNullable<UpdateAttributePatch['config']>
    expectTypeOf<Config>().not.toHaveProperty('targetKind')
    expectTypeOf<Config>().not.toHaveProperty('multi')
    expectTypeOf<Config>().not.toHaveProperty('required')
    const _target: UpdateAttributePatch = {
      id: 'x',
      // @ts-expect-error targetKind is immutable
      config: { targetKind: 'person' },
    }
    const _multi: UpdateAttributePatch = {
      id: 'x',
      // @ts-expect-error multi is immutable (v1)
      config: { multi: true },
    }
    void _target
    void _multi
  })
})

describe('updateAttributeInput (zod boundary)', () => {
  it('strips type, slug, targetKind and multi rather than carrying them', async () => {
    const { updateAttributeInput } = await import('../server/attributes')
    const parsed = updateAttributeInput.parse({
      id: randomUUID(),
      name: 'Renamed',
      type: 'text',
      slug: 'renamed',
      config: { code: 'eur', targetKind: 'company', multi: true },
    })
    expect(parsed).toEqual({
      id: parsed.id,
      name: 'Renamed',
      config: { code: 'EUR' },
    })
  })

  it('carries an option archive flag', async () => {
    const { updateAttributeInput } = await import('../server/attributes')
    const parsed = updateAttributeInput.parse({
      id: randomUUID(),
      options: [{ id: 'a', label: 'A', archived: true }],
    })
    expect(parsed.options).toEqual([{ id: 'a', label: 'A', archived: true }])
  })
})

// ---------------------------------------------------------------------------
// The per-field rules, against the dev database.
// ---------------------------------------------------------------------------

const hasDb = Boolean(process.env.DATABASE_URL)
const tag = randomUUID().slice(0, 8)
const slugFor = (base: string) => `zz_upd_${base}_${tag}`

afterAll(async () => {
  if (!hasDb) return
  await cleanupTestEntities(['^UpdCo [0-9a-f]{4,8}( .*)?$'])
  const { db } = await import('#/db')
  const { attribute } = await import('#/db/schema')
  const { like } = await import('drizzle-orm')
  await db.delete(attribute).where(like(attribute.slug, `zz_upd_%_${tag}`))
})

async function makeAttribute(
  base: string,
  type: 'rating' | 'currency' | 'number' | 'status' | 'record_reference',
  options: Record<string, unknown>,
) {
  const { db } = await import('#/db')
  const { attribute } = await import('#/db/schema')
  const { objectIdForKindAsync } = await import('./objects')
  const objectId = await objectIdForKindAsync('company')
  const row = (
    await db
      .insert(attribute)
      .values({
        objectId,
        slug: slugFor(base),
        name: `Upd ${base} ${tag}`,
        type,
        options,
        isSystem: false,
        sortOrder: 9000,
      })
      .returning({ id: attribute.id, slug: attribute.slug })
  ).at(0)
  if (!row) throw new Error('insert returned nothing')
  return row
}

async function readOptions(id: string) {
  const { db } = await import('#/db')
  const { attribute } = await import('#/db/schema')
  const { eq } = await import('drizzle-orm')
  const row = (
    await db
      .select({ options: attribute.options })
      .from(attribute)
      .where(eq(attribute.id, id))
  ).at(0)
  return row?.options ?? {}
}

describe.skipIf(!hasDb)('updateAttributeProgram', () => {
  it('rejects lowering rating max below stored values, naming the count', async () => {
    const { updateAttributeProgram, RatingMaxBelowValues } =
      await import('./update')
    const { resolveEntity } = await import('../entities/resolve')
    const { setValues } = await import('./values')
    const { db } = await import('#/db')
    const { user } = await import('#/db/schema/auth')
    const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!actor) throw new Error('no user seeded')

    const attr = await makeAttribute('rating', 'rating', { max: 5 })
    for (const rating of [4, 5, 2]) {
      const co = await resolveEntity({
        kind: 'company',
        name: `UpdCo ${tag} r${rating}`,
        source: 'manual',
      })
      await setValues({
        entityId: co.entityId,
        patch: { [attr.slug]: rating },
        actor: { type: 'user', id: actor.id },
      })
    }

    const err = await Effect.runPromise(
      Effect.flip(updateAttributeProgram({ id: attr.id, config: { max: 3 } })),
    )
    expect(err).toBeInstanceOf(RatingMaxBelowValues)
    if (err instanceof RatingMaxBelowValues) {
      expect(err.count).toBe(2)
      expect(err.max).toBe(3)
      expect(err.message).toBe('2 records have ratings above 3')
    }
    expect((await readOptions(attr.id)).max).toBe(5)

    // Lowering to a bound the values already satisfy is fine.
    await Effect.runPromise(
      updateAttributeProgram({ id: attr.id, config: { max: 5 } }),
    )
  })

  it('allows raising rating max', async () => {
    const { updateAttributeProgram } = await import('./update')
    const attr = await makeAttribute('rating_up', 'rating', { max: 5 })
    await Effect.runPromise(
      updateAttributeProgram({ id: attr.id, config: { max: 10 } }),
    )
    expect((await readOptions(attr.id)).max).toBe(10)
  })

  it('allows changing the currency code (relabel only)', async () => {
    const { updateAttributeProgram } = await import('./update')
    const attr = await makeAttribute('currency', 'currency', { code: 'USD' })
    await Effect.runPromise(
      updateAttributeProgram({ id: attr.id, config: { code: 'EUR' } }),
    )
    expect((await readOptions(attr.id)).code).toBe('EUR')
  })

  it('allows changing number precision', async () => {
    const { updateAttributeProgram } = await import('./update')
    const attr = await makeAttribute('number', 'number', {})
    await Effect.runPromise(
      updateAttributeProgram({ id: attr.id, config: { precision: 2 } }),
    )
    expect((await readOptions(attr.id)).precision).toBe(2)
  })

  it('allows regrouping status options', async () => {
    const { updateAttributeProgram } = await import('./update')
    const attr = await makeAttribute('status', 'status', {
      options: [
        { id: 'open', label: 'Open', group: 'active', color: 'blue' },
        { id: 'done', label: 'Done', group: 'closed', color: 'emerald' },
      ],
    })
    await Effect.runPromise(
      updateAttributeProgram({
        id: attr.id,
        options: [
          { id: 'open', label: 'Open', group: 'parked', color: 'blue' },
          { id: 'done', label: 'Done', group: 'closed', color: 'emerald' },
        ],
      }),
    )
    const options = (await readOptions(attr.id)).options ?? []
    expect(options.find((o) => o.id === 'open')?.group).toBe('parked')
  })

  it('archives and restores an option, leaving stored values intact', async () => {
    const { updateAttributeProgram, AttributeConfigRejected } =
      await import('./update')
    const { resolveEntity } = await import('../entities/resolve')
    const { setValues, AttributeValidationError } = await import('./values')
    const { db } = await import('#/db')
    const { entity } = await import('#/db/schema')
    const { user } = await import('#/db/schema/auth')
    const { eq } = await import('drizzle-orm')
    const actor = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (!actor) throw new Error('no user seeded')
    const actorArg = { type: 'user' as const, id: actor.id }

    const attr = await makeAttribute('archive', 'status', {
      options: [
        { id: 'open', label: 'Open', group: 'active', color: 'blue' },
        { id: 'stale', label: 'Stale', group: 'parked', color: 'amber' },
      ],
    })
    const co = await resolveEntity({
      kind: 'company',
      name: `UpdCo ${tag} archive`,
      source: 'manual',
    })
    await setValues({
      entityId: co.entityId,
      patch: { [attr.slug]: 'stale' },
      actor: actorArg,
    })

    // Removal is still refused; archive is the path.
    const removed = await Effect.runPromise(
      Effect.flip(
        updateAttributeProgram({
          id: attr.id,
          options: [{ id: 'open', label: 'Open', group: 'active' }],
        }),
      ),
    )
    expect(removed).toBeInstanceOf(AttributeConfigRejected)
    expect(removed.message).toMatch(/Archive it instead/)

    await Effect.runPromise(
      updateAttributeProgram({
        id: attr.id,
        options: [
          { id: 'open', label: 'Open', group: 'active', color: 'blue' },
          {
            id: 'stale',
            label: 'Stale',
            group: 'parked',
            color: 'amber',
            archived: true,
          },
        ],
      }),
    )
    const archived = (await readOptions(attr.id)).options ?? []
    expect(archived.find((o) => o.id === 'stale')?.archived).toBe(true)
    expect(archived.find((o) => o.id === 'open')?.archived).toBeUndefined()

    // The record still holds the retired value — history stays intact.
    const held = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, co.entityId))
    ).at(0)
    expect(held?.values[attr.slug]).toBe('stale')

    // A fresh write asserting it is rejected; moving off it works.
    const other = await resolveEntity({
      kind: 'company',
      name: `UpdCo ${tag} archive2`,
      source: 'manual',
    })
    await expect(
      setValues({
        entityId: other.entityId,
        patch: { [attr.slug]: 'stale' },
        actor: actorArg,
      }),
    ).rejects.toThrow(AttributeValidationError)
    await setValues({
      entityId: co.entityId,
      patch: { [attr.slug]: 'open' },
      actor: actorArg,
    })

    // Unarchive: absent flag restores; the write goes through again.
    await Effect.runPromise(
      updateAttributeProgram({
        id: attr.id,
        options: [
          { id: 'open', label: 'Open', group: 'active', color: 'blue' },
          { id: 'stale', label: 'Stale', group: 'parked', color: 'amber' },
        ],
      }),
    )
    const restored = (await readOptions(attr.id)).options ?? []
    expect(restored.find((o) => o.id === 'stale')?.archived).toBeUndefined()
    await setValues({
      entityId: other.entityId,
      patch: { [attr.slug]: 'stale' },
      actor: actorArg,
    })
  })

  it('gates each config key to its type', async () => {
    const { updateAttributeProgram, AttributeConfigRejected } =
      await import('./update')
    const attr = await makeAttribute('gate', 'currency', { code: 'USD' })
    const err = await Effect.runPromise(
      Effect.flip(updateAttributeProgram({ id: attr.id, config: { max: 7 } })),
    )
    expect(err).toBeInstanceOf(AttributeConfigRejected)
    expect((await readOptions(attr.id)).max).toBeUndefined()
  })

  it('leaves record_reference targetKind and multi untouched by any patch', async () => {
    const { updateAttributeProgram } = await import('./update')
    const attr = await makeAttribute('ref', 'record_reference', {
      targetKind: 'person',
      multi: false,
    })
    // Keys the patch type does not declare: a variable, not a literal, so
    // excess-property checking lets them through to the program — which has
    // no branch that writes them, so the row comes back unchanged.
    const rogue: AttributeConfigPatch & {
      targetKind: string
      multi: boolean
    } = { targetKind: 'company', multi: true }
    await Effect.runPromise(
      updateAttributeProgram({
        id: attr.id,
        name: `Upd ref ${tag} renamed`,
        config: rogue,
      }),
    )
    const options = await readOptions(attr.id)
    expect(options.targetKind).toBe('person')
    expect(options.multi).toBe(false)
  })
})
