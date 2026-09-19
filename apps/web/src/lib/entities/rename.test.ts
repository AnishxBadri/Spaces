import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * Renaming keeps the old name (SPA-63). `updateRecord` used to set
 * `entity.canonical_name` and record nothing, so the previous name fell out
 * of Cmd-K the moment it was replaced. The rename now writes a `name` alias
 * through the same insert-if-absent check `resolveEntity` uses, for every
 * object-model kind the server fn serves.
 *
 * The server fn itself needs a session, so these drive the program the fn
 * is a wrapper around (`renameRecordProgram`) and the query
 * `searchEntities` is a wrapper around (`entitySearchRows`).
 */

const actorId = async () => {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

const nameAliases = async (entityId: string) => {
  const { db } = await import('@spaces/db')
  const { entityAlias } = await import('@spaces/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const rows = await db
    .select({
      valueNorm: entityAlias.valueNorm,
      value: entityAlias.value,
      sourceClass: entityAlias.sourceClass,
      sourceRef: entityAlias.sourceRef,
    })
    .from(entityAlias)
    .where(
      and(eq(entityAlias.entityId, entityId), eq(entityAlias.kind, 'name')),
    )
  return rows
}

describe('renaming a record', () => {
  it('keeps a company findable by the name it used to have', async () => {
    const { renameRecordProgram } = await import('./rename')
    const { resolveEntity } = await import('./resolve')
    const { entitySearchRows } = await import('../server/search')
    const { normalizeName } = await import('@spaces/core/entities/normalize')
    const { Effect } = await import('effect')
    const tag = randomUUID().slice(0, 8)
    const actor = await actorId()

    const co = await resolveEntity({
      kind: 'company',
      name: `Oldname ${tag}`,
      source: { class: 'manual' },
      createdBy: actor,
    })
    await Effect.runPromise(
      renameRecordProgram(actor, {
        id: co.entityId,
        name: `Newname ${tag}`,
      }),
    )

    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const [row] = await db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, co.entityId))
    expect(row.name).toBe(`Newname ${tag}`)

    // Both names are held: the birth alias was never replaced or deleted.
    const aliases = await nameAliases(co.entityId)
    expect(aliases.map((a) => a.valueNorm).sort()).toEqual(
      [normalizeName(`Oldname ${tag}`), normalizeName(`Newname ${tag}`)].sort(),
    )

    // Cmd-K: the old name still reaches the record.
    const hits = await entitySearchRows(actor, { q: `oldname ${tag}` })
    expect(hits.map((h) => h.id)).toContain(co.entityId)
    // …and so does the new one.
    const fresh = await entitySearchRows(actor, { q: `Newname ${tag}` })
    expect(fresh.map((h) => h.id)).toContain(co.entityId)
  })

  it('records the alias for a custom record too, as manual provenance', async () => {
    const { renameRecordProgram } = await import('./rename')
    const { createObjectProgram, createRecordProgram } =
      await import('../attributes/object-registry')
    const { entitySearchRows } = await import('../server/search')
    const { normalizeName } = await import('@spaces/core/entities/normalize')
    const { Effect } = await import('effect')
    const tag = randomUUID().slice(0, 8)
    const actor = await actorId()

    const fund = await Effect.runPromise(
      createObjectProgram({
        singular: `Fund ${tag}`,
        plural: `Funds ${tag}`,
        createdBy: actor,
      }),
    )
    const rec = await Effect.runPromise(
      createRecordProgram({
        objectId: fund.id,
        name: `Fund I ${tag}`,
        actor: { type: 'user', id: actor },
      }),
    )

    await Effect.runPromise(
      renameRecordProgram(actor, { id: rec.id, name: `Fund II ${tag}` }),
    )

    // Since SPA-60 a custom record is born holding its name alias, so the
    // rename's insert-if-absent on the outgoing name is a no-op and the
    // record ends up with exactly two rows, not three.
    const aliases = await nameAliases(rec.id)
    expect(aliases.map((a) => a.valueNorm).sort()).toEqual(
      [normalizeName(`Fund I ${tag}`), normalizeName(`Fund II ${tag}`)].sort(),
    )
    // Same stamp the at-create alias carries — no new provenance class.
    for (const a of aliases) {
      expect(a.sourceClass).toBe('manual')
      expect(a.sourceRef).toBe(null)
    }

    // …and the birth name still reaches the record after the rename.
    const hits = await entitySearchRows(actor, { q: `Fund I ${tag}` })
    expect(hits.map((h) => h.id)).toContain(rec.id)
  })

  it('is insert-if-absent: renaming back adds no duplicate row', async () => {
    const { renameRecordProgram } = await import('./rename')
    const { resolveEntity } = await import('./resolve')
    const { Effect } = await import('effect')
    const tag = randomUUID().slice(0, 8)
    const actor = await actorId()

    const co = await resolveEntity({
      kind: 'company',
      name: `Round ${tag}`,
      source: { class: 'manual' },
      createdBy: actor,
    })
    for (const name of [
      `Trip ${tag}`,
      `Round ${tag}`,
      `Trip ${tag}`,
      `ROUND ${tag}`,
    ]) {
      await Effect.runPromise(
        renameRecordProgram(actor, { id: co.entityId, name }),
      )
    }
    const aliases = await nameAliases(co.entityId)
    expect(aliases).toHaveLength(2)
  })
})

describe('the dedupe card — "Also seen as"', () => {
  it('never lists the record’s own current name', async () => {
    const { entityContext } = await import('../server/inbox')
    const { resolveEntity } = await import('./resolve')
    const { renameRecordProgram } = await import('./rename')
    const { normalizeName } = await import('@spaces/core/entities/normalize')
    const { Effect } = await import('effect')
    const tag = randomUUID().slice(0, 8)
    const actor = await actorId()

    // The legal suffix is what the old lowercase comparison missed:
    // `normalizeName` strips it, so "acme inc" never equalled "acme".
    const co = await resolveEntity({
      kind: 'company',
      name: `Acme ${tag} Inc`,
      source: { class: 'manual' },
      createdBy: actor,
    })
    const born = await entityContext(co.entityId)
    expect(born.otherNames).toEqual([])

    await Effect.runPromise(
      renameRecordProgram(actor, {
        id: co.entityId,
        name: `Acme ${tag} Works`,
      }),
    )
    const renamed = await entityContext(co.entityId)
    expect(renamed.otherNames).not.toContain(normalizeName(renamed.name))
    expect(renamed.otherNames).toEqual([normalizeName(`Acme ${tag} Inc`)])
  })
})
