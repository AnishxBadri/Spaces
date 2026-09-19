import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * Opt-in identity keys on a custom object (spec §9; CONTEXT.md "Two-tier
 * object model", 2026-09-19). The three doctrine lines this file holds:
 * declaring a key materializes its backing attribute in the same write, the
 * backing attribute is an ordinary non-system attribute, and the backing
 * attribute cannot be archived out from under a standing key.
 */

const nouns = () => {
  const tag = randomUUID().slice(0, 8)
  return { singular: `Fund ${tag}`, plural: `Funds ${tag}`, tag }
}

describe('object identity keys', () => {
  it('materializes the backing attribute of every declared key, in the same write', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram } = await import('./object-registry')
    const { db } = await import('@spaces/db')
    const { attribute, objectDef } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { asc, eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)

    const fund = await Effect.runPromise(
      createObjectProgram({
        ...nouns(),
        identityKeys: ['domain', 'linkedin'],
        createdBy: actor.id,
      }),
    )

    const row = (
      await db
        .select({ identityKeys: objectDef.identityKeys })
        .from(objectDef)
        .where(eq(objectDef.id, fund.id))
    ).at(0)
    expect(row?.identityKeys).toEqual(['domain', 'linkedin'])

    const attrs = await db
      .select({
        slug: attribute.slug,
        type: attribute.type,
        options: attribute.options,
        isSystem: attribute.isSystem,
        archived: attribute.archived,
      })
      .from(attribute)
      .where(eq(attribute.objectId, fund.id))
      .orderBy(asc(attribute.sortOrder))

    expect(attrs.map((a) => a.slug)).toEqual(['domain', 'linkedin'])
    expect(attrs.map((a) => a.type)).toEqual(['domain', 'url'])
    // Not a seeded attribute: the user's own declaration created it.
    expect(attrs.every((a) => a.isSystem === false)).toBe(true)
    expect(attrs.every((a) => a.archived === false)).toBe(true)
    // The write path finds the backing attribute by this, never by slug.
    expect(attrs.map((a) => a.options.identityKey)).toEqual([
      'domain',
      'linkedin',
    ])
  })

  it('leaves no object row behind when a key is refused', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram, ObjectRejected } =
      await import('./object-registry')
    const { db } = await import('@spaces/db')
    const { objectDef } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const { singular, plural, tag } = nouns()

    // email and cin are person/company doctrine — the refusal says so.
    await expect(
      Effect.runPromise(
        createObjectProgram({
          singular,
          plural,
          identityKeys: ['domain', 'email'],
          createdBy: actor.id,
        }),
      ),
    ).rejects.toThrow(
      'email and cin identify people and companies, not custom records',
    )
    await expect(
      Effect.runPromise(
        createObjectProgram({
          singular,
          plural,
          identityKeys: ['cin'],
          createdBy: actor.id,
        }),
      ),
    ).rejects.toThrow(ObjectRejected)
    // Anything else is not a key at all.
    await expect(
      Effect.runPromise(
        createObjectProgram({
          singular,
          plural,
          identityKeys: ['phone'],
          createdBy: actor.id,
        }),
      ),
    ).rejects.toThrow(/not an identity key/)

    const rows = await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, `funds-${tag}`))
    expect(rows).toEqual([])
  })

  it('declares nothing when no key is ticked — the object is still born empty', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram } = await import('./object-registry')
    const { getRegistryByObjectId } = await import('./values')
    const { db } = await import('@spaces/db')
    const { objectDef } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)

    const fund = await Effect.runPromise(
      createObjectProgram({ ...nouns(), createdBy: actor.id }),
    )
    expect(await getRegistryByObjectId(fund.id)).toEqual([])
    const row = (
      await db
        .select({ identityKeys: objectDef.identityKeys })
        .from(objectDef)
        .where(eq(objectDef.id, fund.id))
    ).at(0)
    expect(row?.identityKeys).toEqual([])
  })

  it('refuses identityKey config a type cannot carry', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram } = await import('./object-registry')
    const { createAttributeProgram, AttributeCreateRejected } =
      await import('./create')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const fund = await Effect.runPromise(
      createObjectProgram({ ...nouns(), createdBy: actor.id }),
    )

    await expect(
      Effect.runPromise(
        createAttributeProgram({
          objectId: fund.id,
          name: 'Website',
          type: 'text',
          config: { identityKey: 'domain' },
          createdBy: actor.id,
        }),
      ),
    ).rejects.toThrow(AttributeCreateRejected)
  })

  it('refuses to archive a backing attribute while its key is declared, naming the object', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram } = await import('./object-registry')
    const { createAttributeProgram } = await import('./create')
    const { updateAttributeProgram } = await import('./update')
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { and, eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const { singular, plural } = nouns()

    const fund = await Effect.runPromise(
      createObjectProgram({
        singular,
        plural,
        identityKeys: ['domain'],
        createdBy: actor.id,
      }),
    )
    const [backing] = await db
      .select({ id: attribute.id })
      .from(attribute)
      .where(and(eq(attribute.objectId, fund.id), eq(attribute.slug, 'domain')))

    await expect(
      Effect.runPromise(
        updateAttributeProgram({ id: backing.id, archived: true }),
      ),
    ).rejects.toThrow(plural)
    const after = (
      await db
        .select({ archived: attribute.archived })
        .from(attribute)
        .where(eq(attribute.id, backing.id))
    ).at(0)
    expect(after?.archived).toBe(false)

    // Renaming it is still free, and so is archiving anything else.
    await Effect.runPromise(
      updateAttributeProgram({ id: backing.id, name: 'Website' }),
    )
    const other = await Effect.runPromise(
      createAttributeProgram({
        objectId: fund.id,
        name: 'Vintage',
        type: 'number',
        createdBy: actor.id,
      }),
    )
    await Effect.runPromise(
      updateAttributeProgram({ id: other.id, archived: true }),
    )
    const rows = await db
      .select({
        slug: attribute.slug,
        name: attribute.name,
        archived: attribute.archived,
      })
      .from(attribute)
      .where(eq(attribute.objectId, fund.id))
    expect(rows).toContainEqual({
      slug: 'domain',
      name: 'Website',
      archived: false,
    })
    expect(rows).toContainEqual({
      slug: 'vintage',
      name: 'Vintage',
      archived: true,
    })
  })
})

/**
 * The slug rule applied to the declaration (spec §9, §3): revisable while
 * the object has no records, frozen the moment one exists — otherwise a
 * record's alias outlives the key that justified it.
 */
describe('revising an object’s identity keys', () => {
  it('accepts a revision while empty and refuses one once a record exists', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram, createRecordProgram, updateObjectProgram } =
      await import('./object-registry')
    const { db } = await import('@spaces/db')
    const { attribute, objectDef } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { asc, eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const { singular, plural } = nouns()

    const fund = await Effect.runPromise(
      createObjectProgram({
        singular,
        plural,
        identityKeys: ['domain'],
        createdBy: actor.id,
      }),
    )

    // Empty: the declaration widens, and the new key's backing attribute is
    // materialized exactly the way creation materializes one.
    await Effect.runPromise(
      updateObjectProgram({
        id: fund.id,
        identityKeys: ['domain', 'linkedin'],
        declaredBy: actor.id,
      }),
    )
    const declared = async () =>
      (
        await db
          .select({ identityKeys: objectDef.identityKeys })
          .from(objectDef)
          .where(eq(objectDef.id, fund.id))
      ).at(0)?.identityKeys
    const backing = async () =>
      await db
        .select({
          slug: attribute.slug,
          type: attribute.type,
          options: attribute.options,
          isSystem: attribute.isSystem,
        })
        .from(attribute)
        .where(eq(attribute.objectId, fund.id))
        .orderBy(asc(attribute.sortOrder))
    expect(await declared()).toEqual(['domain', 'linkedin'])
    expect(await backing()).toEqual([
      {
        slug: 'domain',
        type: 'domain',
        options: { identityKey: 'domain' },
        isSystem: false,
      },
      {
        slug: 'linkedin',
        type: 'url',
        options: { identityKey: 'linkedin' },
        isSystem: false,
      },
    ])

    // One record, and the declaration is schema history from here on.
    await Effect.runPromise(
      createRecordProgram({
        objectId: fund.id,
        name: 'First fund',
        actor: { type: 'user', id: actor.id },
      }),
    )
    await expect(
      Effect.runPromise(
        updateObjectProgram({
          id: fund.id,
          identityKeys: ['domain'],
          declaredBy: actor.id,
        }),
      ),
    ).rejects.toThrow(`${plural} has records — identity keys are frozen`)
    // Nothing written: neither the column nor the attribute it points at.
    expect(await declared()).toEqual(['domain', 'linkedin'])
    expect((await backing()).map((a) => a.slug)).toEqual(['domain', 'linkedin'])

    // Re-sending what already stands is not a change, so the nouns still
    // rename freely on a populated object.
    await Effect.runPromise(
      updateObjectProgram({
        id: fund.id,
        plural: `Vehicles ${plural}`,
        identityKeys: ['linkedin', 'domain'],
        declaredBy: actor.id,
      }),
    )
    const after = (
      await db
        .select({ plural: objectDef.plural })
        .from(objectDef)
        .where(eq(objectDef.id, fund.id))
    ).at(0)
    expect(after?.plural).toBe(`Vehicles ${plural}`)
  })

  it('deletes the backing attribute row when a key is dropped from an empty object', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram, updateObjectProgram } =
      await import('./object-registry')
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)

    const fund = await Effect.runPromise(
      createObjectProgram({
        ...nouns(),
        identityKeys: ['domain', 'linkedin'],
        createdBy: actor.id,
      }),
    )
    await Effect.runPromise(
      updateObjectProgram({
        id: fund.id,
        identityKeys: ['domain'],
        declaredBy: actor.id,
      }),
    )
    // Gone, not archived: an empty object holds no values, so an archived
    // column would be preserving nothing.
    const rows = async () =>
      await db
        .select({ slug: attribute.slug, archived: attribute.archived })
        .from(attribute)
        .where(eq(attribute.objectId, fund.id))
    expect(await rows()).toEqual([{ slug: 'domain', archived: false }])

    // Re-declaring it materializes a fresh one through the same door.
    await Effect.runPromise(
      updateObjectProgram({
        id: fund.id,
        identityKeys: ['domain', 'linkedin'],
        declaredBy: actor.id,
      }),
    )
    expect((await rows()).map((r) => r.slug).sort()).toEqual([
      'domain',
      'linkedin',
    ])
  })

  it('counts a merged-away record — it still holds the values the key justified', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram, createRecordProgram, updateObjectProgram } =
      await import('./object-registry')
    const { db } = await import('@spaces/db')
    const { attribute, entity } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const me = { type: 'user' as const, id: actor.id }

    // The merge target lives on another object, so the object under test is
    // left holding exactly one row and that row is merged away.
    const other = await Effect.runPromise(
      createObjectProgram({ ...nouns(), createdBy: actor.id }),
    )
    const winner = await Effect.runPromise(
      createRecordProgram({ objectId: other.id, name: 'Winner', actor: me }),
    )
    const { singular, plural } = nouns()
    const fund = await Effect.runPromise(
      createObjectProgram({
        singular,
        plural,
        identityKeys: ['domain'],
        createdBy: actor.id,
      }),
    )
    const loser = await Effect.runPromise(
      createRecordProgram({ objectId: fund.id, name: 'Loser', actor: me }),
    )
    await db
      .update(entity)
      .set({ mergedIntoId: winner.id })
      .where(eq(entity.id, loser.id))

    await expect(
      Effect.runPromise(
        updateObjectProgram({
          id: fund.id,
          identityKeys: [],
          declaredBy: actor.id,
        }),
      ),
    ).rejects.toThrow(`${plural} has records — identity keys are frozen`)
    const rows = await db
      .select({ slug: attribute.slug })
      .from(attribute)
      .where(eq(attribute.objectId, fund.id))
    expect(rows).toEqual([{ slug: 'domain' }])
  })
})
