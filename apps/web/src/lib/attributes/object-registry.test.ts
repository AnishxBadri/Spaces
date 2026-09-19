import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { slugifyNoun, suggestPlural } from '#/lib/object-nouns'

describe('object nouns (pure)', () => {
  it('suggests plurals and slugs from the plural', () => {
    expect(suggestPlural('Fund')).toBe('Funds')
    expect(suggestPlural('Company')).toBe('Companies')
    expect(suggestPlural('Class')).toBe('Classes')
    expect(slugifyNoun('Limited Partners')).toBe('limited-partners')
  })
})

describe('custom objects', () => {
  const tag = randomUUID().slice(0, 8)

  // No afterAll: isolation is per file and structural since SPA-145 — the
  // setup file truncates and reseeds before this file is imported. The
  // hand-written delete list that used to live here outlived its purpose
  // and, once a custom record started carrying a birth alias (SPA-60),
  // started failing on the alias's own foreign key.

  it('creates an object, its attributes, records with defaults, and references both ways', async () => {
    const { Effect } = await import('effect')
    const {
      createObjectProgram,
      createRecordProgram,
      updateObjectProgram,
      ObjectRejected,
    } = await import('./object-registry')
    const { createAttributeProgram } = await import('./create')
    const { setValues, getRegistryByObjectId } = await import('./values')
    const { objectIdForKindAsync } = await import('./objects')
    const { db } = await import('@spaces/db')
    const { entity, link, objectDef } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { and, eq } = await import('drizzle-orm')
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const me = { type: 'user' as const, id: actor.id }

    // Reserved and empty nouns are refused; a normal one gets a slug.
    await expect(
      Effect.runPromise(
        createObjectProgram({
          singular: 'Deal',
          plural: 'Deals',
          createdBy: actor.id,
        }),
      ),
    ).rejects.toThrow(ObjectRejected)
    const fund = await Effect.runPromise(
      createObjectProgram({
        singular: `Fund ${tag}`,
        plural: `Funds ${tag}`,
        icon: 'landmark',
        createdBy: actor.id,
      }),
    )
    expect(fund.slug).toBe(`funds-${tag}`)
    // Same plural again → suffixed, never a collision.
    const fund2 = await Effect.runPromise(
      createObjectProgram({
        singular: `Fund ${tag}`,
        plural: `Funds ${tag}`,
        createdBy: actor.id,
      }),
    )
    expect(fund2.slug).toBe(`funds-${tag}-2`)

    // Born with zero registry rows; attributes come from the same engine.
    expect(await getRegistryByObjectId(fund.id)).toEqual([])
    await Effect.runPromise(
      createAttributeProgram({
        objectId: fund.id,
        name: 'Vintage',
        type: 'number',
        default: 2026,
        createdBy: actor.id,
      }),
    )
    const dealObjectId = await objectIdForKindAsync('deal')
    // A deal can point at a Fund (targetObjectId) …
    const dealRef = await Effect.runPromise(
      createAttributeProgram({
        objectId: dealObjectId,
        name: `Zz fund ref ${tag}`,
        type: 'record_reference',
        config: { targetObjectId: fund.id },
        createdBy: actor.id,
      }),
    )
    // … and a Fund can point at a company (targetKind).
    await Effect.runPromise(
      createAttributeProgram({
        objectId: fund.id,
        name: 'Anchor',
        type: 'record_reference',
        config: { targetKind: 'company' },
        createdBy: actor.id,
      }),
    )

    // Record birth: name required, defaults fire, kind = custom.
    await expect(
      Effect.runPromise(
        createRecordProgram({ objectId: fund.id, name: '  ', actor: me }),
      ),
    ).rejects.toThrow(/needs a name/)
    const rec = await Effect.runPromise(
      createRecordProgram({
        objectId: fund.id,
        name: `Fund I ${tag}`,
        actor: me,
      }),
    )
    const [row] = await db
      .select({
        kind: entity.kind,
        values: entity.values,
        objectId: entity.objectId,
      })
      .from(entity)
      .where(eq(entity.id, rec.id))
    expect(row.kind).toBe('custom')
    expect(row.objectId).toBe(fund.id)
    expect(row.values.vintage).toBe(2026)

    // A deal referencing the Fund materializes a link; a company id is
    // rejected because the target is single-object.
    const [dealRow] = await db
      .insert(entity)
      .values({
        kind: 'deal',
        objectId: dealObjectId,
        canonicalName: `Zz deal ${tag}`,
      })
      .returning({ id: entity.id })
    await setValues({
      entityId: dealRow.id,
      patch: { [dealRef.slug]: rec.id },
      actor: me,
    })
    const links = await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(
        and(eq(link.fromEntityId, dealRow.id), eq(link.relation, 'references')),
      )
    expect(links.map((l) => l.to)).toEqual([rec.id])
    const someCompany = (
      await db
        .select({ id: entity.id })
        .from(entity)
        .where(eq(entity.kind, 'company'))
        .limit(1)
    ).at(0)
    if (someCompany)
      await expect(
        setValues({
          entityId: dealRow.id,
          patch: { [dealRef.slug]: someCompany.id },
          actor: me,
        }),
      ).rejects.toThrow(/target object/)

    // Lifecycle: nouns rename, slug frozen; archive is custom-only.
    await Effect.runPromise(
      updateObjectProgram({
        id: fund.id,
        plural: `Vehicles ${tag}`,
        archived: true,
      }),
    )
    const [after] = await db
      .select({
        slug: objectDef.slug,
        plural: objectDef.plural,
        archived: objectDef.archived,
      })
      .from(objectDef)
      .where(eq(objectDef.id, fund.id))
    expect(after).toEqual({
      slug: `funds-${tag}`,
      plural: `Vehicles ${tag}`,
      archived: true,
    })
    await expect(
      Effect.runPromise(
        updateObjectProgram({ id: dealObjectId, archived: true }),
      ),
    ).rejects.toThrow(/System objects/)
    await expect(
      Effect.runPromise(
        createRecordProgram({ objectId: fund.id, name: 'late', actor: me }),
      ),
    ).rejects.toThrow(/archived/)
  })
})
