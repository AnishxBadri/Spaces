import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * Integration test against the test database (SPA-77). The demo, in three
 * parts: a document tagged into a space and linked to a task deletes and
 * takes nothing else with it; an entity named by a merge_event refuses; the
 * mandate's note refuses. The imports are dynamic like the rest of the
 * DB-coupled suite — `@spaces/db` builds its pool from `DATABASE_URL` at
 * import time and `vitest.setup.ts` rewrites it per file.
 */

/**
 * The SQLSTATE of a rejected query. drizzle wraps the driver's error in a
 * `Failed query: …` of its own, so the code — 23503 is foreign_key_violation
 * — is one or more `cause` hops down.
 */
function sqlStateOf(error: unknown): string | undefined {
  let cursor: unknown = error
  while (cursor instanceof Error) {
    if ('code' in cursor && typeof cursor.code === 'string') return cursor.code
    cursor = cursor.cause
  }
  return undefined
}

/** A document entity with a side row, a space tag, a task and a mention. */
async function buildTaggedDocument(tag: string) {
  const { db } = await import('@spaces/db')
  const { document, entity, entitySpace, link, space } =
    await import('@spaces/db/schema')
  const { activity } = await import('@spaces/db/schema/activity')
  const { task, taskEntity } = await import('@spaces/db/schema/tasks')
  const { user } = await import('@spaces/db/schema/auth')

  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()

  const [spc] = await db
    .insert(entity)
    .values({ kind: 'space', canonicalName: `DelSpace ${tag}` })
    .returning({ id: entity.id })
  await db
    .insert(space)
    .values({ entityId: spc.id, slug: `delspace_${tag}`, path: `d_${tag}` })

  const [doc] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: `deck-${tag}.pdf` })
    .returning({ id: entity.id })
  await db.insert(document).values({
    entityId: doc.id,
    blobSha: null,
    filename: `deck-${tag}.pdf`,
    kind: 'deck',
    sourceClass: 'manual',
  })

  // The four rows the hand-written lists missed, and the two they cleared.
  await db
    .insert(entitySpace)
    .values({ entityId: doc.id, spaceId: spc.id, source: 'manual' })

  const [chore] = await db
    .insert(task)
    .values({
      content: `Read ${tag}`,
      assigneeId: actor.id,
      createdBy: actor.id,
    })
    .returning({ id: task.id })
  await db.insert(taskEntity).values({ taskId: chore.id, entityId: doc.id })

  const [noteEnt] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: `DelNote ${tag}` })
    .returning({ id: entity.id })
  await db.insert(link).values({
    fromEntityId: noteEnt.id,
    toEntityId: doc.id,
    relation: 'mentions',
    source: 'manual',
  })
  await db.insert(activity).values({
    actorId: actor.id,
    verb: 'document.filed',
    subjectEntityId: noteEnt.id,
    objectEntityId: doc.id,
  })

  return { actorId: actor.id, docId: doc.id, spaceId: spc.id, taskId: chore.id }
}

describe('deleteEntity', () => {
  it('deletes a tagged, task-linked document that the old hand-list could not', async () => {
    const { deleteEntityProgram } = await import('./delete')
    const { db } = await import('@spaces/db')
    const { document, entity, entitySpace, link } =
      await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { task, taskEntity } = await import('@spaces/db/schema/tasks')
    const { eq, or } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const built = await buildTaggedDocument(tag)

    // The failure this slice exists to remove: deleteDocument's hand-list
    // cleared chunks, links, activity, the document row and the entity row,
    // and knew nothing about entity_space — so Postgres refused the entity
    // delete. Run that exact list and watch it still refuse.
    const oldPathFailure = await db
      .transaction(async (tx) => {
        await tx
          .delete(link)
          .where(
            or(
              eq(link.fromEntityId, built.docId),
              eq(link.toEntityId, built.docId),
            ),
          )
        await tx
          .delete(activity)
          .where(
            or(
              eq(activity.subjectEntityId, built.docId),
              eq(activity.objectEntityId, built.docId),
            ),
          )
        await tx.delete(document).where(eq(document.entityId, built.docId))
        await tx.delete(entity).where(eq(entity.id, built.docId))
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(sqlStateOf(oldPathFailure)).toBe('23503')

    // The registry walk deletes the same entity without complaint.
    const outcome = await Effect.runPromise(deleteEntityProgram(built.docId))
    expect(outcome).toEqual({ deleted: true })

    const gone = async (rows: Promise<Array<unknown>>) =>
      expect(await rows).toHaveLength(0)
    await gone(db.select().from(entity).where(eq(entity.id, built.docId)))
    await gone(
      db.select().from(document).where(eq(document.entityId, built.docId)),
    )
    await gone(
      db
        .select()
        .from(entitySpace)
        .where(eq(entitySpace.entityId, built.docId)),
    )
    await gone(
      db.select().from(taskEntity).where(eq(taskEntity.entityId, built.docId)),
    )
    await gone(db.select().from(link).where(eq(link.toEntityId, built.docId)))

    // The two rows that are not about the document survive it: the space it
    // was tagged into, and the task it was linked to — one fewer record.
    const spaceRow = await db
      .select()
      .from(entity)
      .where(eq(entity.id, built.spaceId))
    expect(spaceRow).toHaveLength(1)
    const taskRow = await db
      .select()
      .from(task)
      .where(eq(task.id, built.taskId))
    expect(taskRow).toHaveLength(1)
    const stillLinked = await db
      .select()
      .from(taskEntity)
      .where(eq(taskEntity.taskId, built.taskId))
    expect(stillLinked).toHaveLength(0)
  })

  it('refuses an entity named by a merge_event, and leaves it standing', async () => {
    const { Blocked, deleteEntityProgram } = await import('./delete')
    const { db } = await import('@spaces/db')
    const { company, entity, mergeEvent } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const pair = await db
      .insert(entity)
      .values([
        { kind: 'company', canonicalName: `Winner ${tag}` },
        { kind: 'company', canonicalName: `Loser ${tag}` },
      ])
      .returning({ id: entity.id })
    await db
      .insert(company)
      .values([{ entityId: pair[0].id }, { entityId: pair[1].id }])
    await db.insert(mergeEvent).values({
      winnerId: pair[0].id,
      loserId: pair[1].id,
      mergedBy: actor.id,
      snapshot: [],
    })

    // `Effect.flip` puts the typed failure in the success channel — the
    // assertion is that this is a `Blocked` value, not a thrown string.
    const failure = await Effect.runPromise(
      Effect.flip(deleteEntityProgram(pair[0].id)),
    )
    expect(failure).toBeInstanceOf(Blocked)
    if (failure._tag !== 'Blocked') throw new Error('expected Blocked')
    expect(failure.key).toBe('merge_event.winner')
    expect(failure.reason).toMatch(/history is information/)

    const still = await db
      .select()
      .from(entity)
      .where(eq(entity.id, pair[0].id))
    expect(still).toHaveLength(1)
  })

  it('refuses the mandate’s note by name, and rolls the attempt back', async () => {
    const { deleteEntityProgram } = await import('./delete')
    const { db } = await import('@spaces/db')
    const { entity, entitySpace, note, space } =
      await import('@spaces/db/schema')
    const { mandate } = await import('@spaces/db/schema/workspace')
    const { user } = await import('@spaces/db/schema/auth')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)

    const [spc] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: `MandateSpace ${tag}` })
      .returning({ id: entity.id })
    await db.insert(space).values({
      entityId: spc.id,
      slug: `mandatespace_${tag}`,
      path: `m_${tag}`,
    })

    const [noteEnt] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: `Mandate ${tag}` })
      .returning({ id: entity.id })
    await db.insert(note).values({
      entityId: noteEnt.id,
      title: `Mandate ${tag}`,
      authorId: actor.id,
    })
    // A cascade row that must still be there afterwards: the rollback is
    // what makes the next test in this file see a consistent database.
    await db
      .insert(entitySpace)
      .values({ entityId: noteEnt.id, spaceId: spc.id, source: 'manual' })
    await db.insert(mandate).values({ noteEntityId: noteEnt.id })

    const failure = await Effect.runPromise(
      Effect.flip(deleteEntityProgram(noteEnt.id)),
    )
    if (failure._tag !== 'Blocked') throw new Error('expected Blocked')
    expect(failure.key).toBe('mandate.note')

    const rows = await db.select().from(entity).where(eq(entity.id, noteEnt.id))
    expect(rows).toHaveLength(1)
    const sideRow = await db
      .select()
      .from(note)
      .where(eq(note.entityId, noteEnt.id))
    expect(sideRow).toHaveLength(1)
    const tagRow = await db
      .select()
      .from(entitySpace)
      .where(eq(entitySpace.entityId, noteEnt.id))
    expect(tagRow).toHaveLength(1)
  })

  it('still works on the next entity after a refusal, and is idempotent', async () => {
    const { deleteEntityProgram } = await import('./delete')
    const { db } = await import('@spaces/db')
    const { entity, term } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [ent] = await db
      .insert(entity)
      .values({ kind: 'term', canonicalName: `SAFE ${tag}` })
      .returning({ id: entity.id })
    await db.insert(term).values({ entityId: ent.id, name: `SAFE ${tag}` })

    expect(await Effect.runPromise(deleteEntityProgram(ent.id))).toEqual({
      deleted: true,
    })
    expect(
      await db.select().from(term).where(eq(term.entityId, ent.id)),
    ).toHaveLength(0)
    // Deleting what is already gone is the same outcome, not an error.
    expect(await Effect.runPromise(deleteEntityProgram(ent.id))).toEqual({
      deleted: false,
    })
  })
})
