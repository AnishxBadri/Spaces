import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * Note creation (SPA-104), against the test database.
 *
 * The bug: "Note about this" on a record wrote one `link(mentions,
 * extracted)` row, so the note was referenced by the company and never filed
 * against it — and `saveNote`'s diff-sync owns exactly that stamp, so
 * deleting the starter block took the note's only edge with it. The filing
 * and the mention are two different rows here, and the second test is the
 * one that proves it: the mention goes, the filing stays.
 *
 * Imports are dynamic like the rest of the DB-coupled suite: `@spaces/db`
 * builds its pool from `DATABASE_URL` at import time and `vitest.setup.ts`
 * rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

/** A live company to write a note about. */
async function aCompany(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: `Kestrel ${tag}` })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

/** Every edge the new note has, as `relation:source` pairs. */
async function edgesFrom(noteId: string): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { link } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const rows = await db
    .select({
      relation: link.relation,
      source: link.source,
      to: link.toEntityId,
    })
    .from(link)
    .where(eq(link.fromEntityId, noteId))
  return rows.map((r) => `${r.relation}:${r.source}:${r.to}`).sort()
}

describe('createNoteProgram', () => {
  it('files a record note with tagged_in/manual and mentions it with extracted', async () => {
    const { createNoteProgram } = await import('./create')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()
    const companyId = await aCompany(tag)

    const { id } = await Effect.runPromise(
      createNoteProgram(author, {
        about: {
          entityId: companyId,
          label: `Kestrel ${tag}`,
          kind: 'company',
          objectSlug: '',
        },
        noteKind: 'note',
      }),
    )

    // Exactly two rows: the act, and the side effect of the starter block.
    expect(await edgesFrom(id)).toEqual([
      `mentions:extracted:${companyId}`,
      `tagged_in:manual:${companyId}`,
    ])

    // And no space filing — entity_space is the space mechanism alone.
    const { db } = await import('@spaces/db')
    const { entitySpace, note } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    expect(
      await db.select().from(entitySpace).where(eq(entitySpace.entityId, id)),
    ).toHaveLength(0)

    // The starter block is what the mention mirrors, so it has to be there.
    const row = (
      await db
        .select({ bodyJson: note.bodyJson, bodyMd: note.bodyMd })
        .from(note)
        .where(eq(note.entityId, id))
    ).at(0)
    expect(row?.bodyMd).toContain(`[[Kestrel ${tag}|entity:${companyId}]]`)
    expect(JSON.stringify(row?.bodyJson)).toContain(companyId)
  })

  it('keeps the filing when the starter mention block is deleted and saved', async () => {
    const { createNoteProgram } = await import('./create')
    const { db } = await import('@spaces/db')
    const { link } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()
    const companyId = await aCompany(tag)

    const { id } = await Effect.runPromise(
      createNoteProgram(author, {
        about: {
          entityId: companyId,
          label: `Kestrel ${tag}`,
          kind: 'company',
          objectSlug: '',
        },
        noteKind: 'note',
      }),
    )

    // Exactly what `saveNote` does to the mentions it owns when the block is
    // gone: delete the extracted rows no longer wanted. The filing is not
    // one of the rows it owns, which is the whole fix.
    await db
      .delete(link)
      .where(
        and(
          eq(link.fromEntityId, id),
          eq(link.relation, 'mentions'),
          eq(link.source, 'extracted'),
        ),
      )

    expect(await edgesFrom(id)).toEqual([`tagged_in:manual:${companyId}`])

    // Still under "Filed here" afterwards — the lane reads tagged_in.
    const { listRecordNotesProgram } = await import('./list-record')
    const lanes = await Effect.runPromise(
      listRecordNotesProgram(author, companyId),
    )
    expect(lanes.filed.map((f) => f.id)).toEqual([id])
    expect(lanes.mentions).toEqual([])
  })

  it('files a space note through entity_space and writes no link row', async () => {
    const { createNoteProgram } = await import('./create')
    const { db } = await import('@spaces/db')
    const { entity, entitySpace, space } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const author = await actorId()

    const [ent] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: `Grid ${tag}` })
      .returning({ id: entity.id })
    await db
      .insert(space)
      .values({ entityId: ent.id, slug: `grid_${tag}`, path: `g_${tag}` })

    const { id } = await Effect.runPromise(
      createNoteProgram(author, {
        about: {
          entityId: ent.id,
          label: `Grid ${tag}`,
          kind: 'space',
          objectSlug: '',
        },
        noteKind: 'note',
      }),
    )

    expect(await edgesFrom(id)).toEqual([])
    const filings = await db
      .select({ spaceId: entitySpace.spaceId, source: entitySpace.source })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, id))
    expect(filings).toEqual([{ spaceId: ent.id, source: 'manual' }])
  })

  it('writes no edge and no filing for a note started from nowhere', async () => {
    const { createNoteProgram } = await import('./create')
    const { db } = await import('@spaces/db')
    const { entitySpace, note } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const author = await actorId()
    const { id } = await Effect.runPromise(
      createNoteProgram(author, { about: null, noteKind: 'note' }),
    )

    expect(await edgesFrom(id)).toEqual([])
    expect(
      await db.select().from(entitySpace).where(eq(entitySpace.entityId, id)),
    ).toHaveLength(0)
    const row = (
      await db
        .select({ bodyJson: note.bodyJson, bodyMd: note.bodyMd })
        .from(note)
        .where(eq(note.entityId, id))
    ).at(0)
    expect(row?.bodyJson).toBeNull()
    expect(row?.bodyMd).toBe('')
  })
})
