import { randomUUID } from 'node:crypto'
import { Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'

const ASOF = '2026-10-28T00:00:00Z'

/**
 * Archive and restore on the test database: one round trip on a company,
 * and what archive takes it out of — the search lanes and pickers, and the
 * context walk from a record that links to it — while its own assembly and
 * its archive read still answer. A space is not archived here.
 */
describe('archiveRecordProgram / restoreRecordProgram', () => {
  const tag = randomUUID().slice(0, 8)

  it('round-trips, and takes the record out of search and context meanwhile', async () => {
    const { and, eq } = await import('drizzle-orm')
    const { db } = await import('@spaces/db')
    const { entity, link } = await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { user } = await import('@spaces/db/schema/auth')
    const { resolveEntity } = await import('./resolve')
    const { archiveRecordProgram, recordArchiveProgram, restoreRecordProgram } =
      await import('./archive')
    const { entitySearchRows } = await import('../read/entity-search')
    const { lexicalRowsProgram } = await import('../read/search')
    const { assembleProgram } = await import('../context/assemble')
    const { SimilarLaneEmpty } = await import('../../context/similar-lane')

    const me = (
      await db.select({ id: user.id, name: user.name }).from(user).limit(1)
    ).at(0)
    if (me === undefined) throw new Error('no fixture user')

    const co = await resolveEntity({
      kind: 'company',
      name: `Archco ${tag}`,
      keys: { domain: `archco-${tag}.com` },
      source: { class: 'manual' },
    })
    const ada = await resolveEntity({
      kind: 'person',
      name: `Ada ${tag}`,
      keys: { email: `ada-${tag}@example.test` },
      source: { class: 'manual' },
    })
    await db.insert(link).values({
      fromEntityId: ada.entityId,
      toEntityId: co.entityId,
      relation: 'mentions',
    })

    const run = <TValue, TError>(eff: Effect.Effect<TValue, TError>) =>
      Effect.runPromise(eff)
    const found = async () => ({
      picker: (await entitySearchRows(me.id, { q: `Archco ${tag}` })).map(
        (r) => r.id,
      ),
      search: (
        await run(lexicalRowsProgram({ userId: me.id, q: `Archco ${tag}` }))
      ).map((r) => r.id),
    })
    const walkFromAda = async () =>
      (
        await run(
          assembleProgram(
            { entityId: ada.entityId },
            { user: { id: me.id }, asOf: ASOF, budgetChars: 20_000 },
          ).pipe(Effect.provide(SimilarLaneEmpty)),
        )
      ).items.flatMap((i) => i.entityIds)

    // Live: in the picker, the search and the walk.
    expect((await found()).picker).toContain(co.entityId)
    expect((await found()).search).toContain(co.entityId)
    expect(await walkFromAda()).toContain(co.entityId)
    expect(await run(recordArchiveProgram(co.entityId))).toBeNull()

    const archived = await run(archiveRecordProgram(me.id, co.entityId))
    expect(archived.by).toBe(me.name)
    expect(Date.parse(archived.on)).not.toBeNaN()
    expect(await run(recordArchiveProgram(co.entityId))).toEqual(archived)
    // A second archive answers the first and writes nothing.
    expect(await run(archiveRecordProgram(me.id, co.entityId))).toEqual(
      archived,
    )
    const verbs = async () =>
      (
        await db
          .select({ verb: activity.verb })
          .from(activity)
          .where(eq(activity.subjectEntityId, co.entityId))
      ).map((r) => r.verb)
    expect((await verbs()).filter((v) => v === 'record.archived')).toHaveLength(
      1,
    )

    // Archived: gone from the picker, the search and the walk…
    expect((await found()).picker).not.toContain(co.entityId)
    expect((await found()).search).not.toContain(co.entityId)
    expect(await walkFromAda()).not.toContain(co.entityId)
    // …but its own assembly still opens, and nothing was deleted.
    const own = await run(
      assembleProgram(
        { entityId: co.entityId },
        { user: { id: me.id }, asOf: ASOF, budgetChars: 20_000 },
      ).pipe(Effect.provide(SimilarLaneEmpty)),
    )
    expect(own.seed.id).toBe(co.entityId)
    expect(
      await db
        .select({ id: link.id })
        .from(link)
        .where(
          and(
            eq(link.fromEntityId, ada.entityId),
            eq(link.toEntityId, co.entityId),
          ),
        ),
    ).toHaveLength(1)

    expect(await run(restoreRecordProgram(me.id, co.entityId))).toEqual({
      restored: true,
    })
    expect(await run(recordArchiveProgram(co.entityId))).toBeNull()
    const row = (
      await db
        .select({ by: entity.archivedBy })
        .from(entity)
        .where(eq(entity.id, co.entityId))
    ).at(0)
    expect(row?.by).toBeNull()
    expect(await run(restoreRecordProgram(me.id, co.entityId))).toEqual({
      restored: false,
    })
    expect(await verbs()).toContain('record.restored')

    // Restored: back everywhere it left.
    expect((await found()).picker).toContain(co.entityId)
    expect((await found()).search).toContain(co.entityId)
    expect(await walkFromAda()).toContain(co.entityId)
  })

  it('refuses a space, which archives with its subtree instead', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { archiveRecordProgram } = await import('./archive')
    const me = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (me === undefined) throw new Error('no fixture user')
    const spaceEntity = (
      await db
        .insert(entity)
        .values({ kind: 'space', canonicalName: `Archspace ${tag}` })
        .returning({ id: entity.id })
    ).at(0)
    if (spaceEntity === undefined) throw new Error('no space')
    const exit = await Effect.runPromiseExit(
      archiveRecordProgram(me.id, spaceEntity.id),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('RecordNotFound')
  })
})
