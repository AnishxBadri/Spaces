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
