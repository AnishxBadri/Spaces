import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, entitySpace, link, note, space } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { saveNoteAsNewVersionProgram } from './new-version'
import { NoteNotFound } from './delete'

/** "Save as new version": a copy filed where the old note is, superseding it. */

async function make(kind: 'company' | 'space' | 'note', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('entity insert returned no row')
  return row.id
}

const edges = async (from: string) =>
  (
    await db
      .select({ to: link.toEntityId, relation: link.relation })
      .from(link)
      .where(eq(link.fromEntityId, from))
  )
    .map((e) => `${e.relation}:${e.to}`)
    .sort()

describe('saveNoteAsNewVersionProgram', () => {
  it('copies the note and its filings, and links new → old with supersedes', async () => {
    const tag = randomUUID().slice(0, 8)
    const co = await make('company', `Versioned ${tag}`)
    const spc = await make('space', `Space ${tag}`)
    await db
      .insert(space)
      .values({ entityId: spc, slug: `s_${tag}`, path: `s_${tag}` })
    const old = await make('note', 'Call notes')
    await db.insert(note).values({
      entityId: old,
      authorId: FIXTURE_ACTOR.id,
      title: 'Call notes',
      kind: 'memo',
      bodyMd: 'Pilot went well.',
      visibility: 'shared',
    })
    await db.insert(link).values([
      { fromEntityId: old, toEntityId: co, relation: 'tagged_in' },
      {
        fromEntityId: old,
        toEntityId: co,
        relation: 'mentions',
        source: 'extracted',
      },
    ])
    await db
      .insert(entitySpace)
      .values({ entityId: old, spaceId: spc, source: 'manual' })

    const { id } = await Effect.runPromise(
      saveNoteAsNewVersionProgram(FIXTURE_ACTOR.id, old),
    )
    expect(id).not.toBe(old)

    const copy = (await db.select().from(note).where(eq(note.entityId, id))).at(
      0,
    )
    expect(copy).toMatchObject({
      title: 'Call notes',
      kind: 'memo',
      bodyMd: 'Pilot went well.',
      visibility: 'shared',
    })
    expect(await edges(id)).toEqual(
      [`mentions:${co}`, `supersedes:${old}`, `tagged_in:${co}`].sort(),
    )
    expect(
      await db
        .select({ spaceId: entitySpace.spaceId })
        .from(entitySpace)
        .where(eq(entitySpace.entityId, id)),
    ).toEqual([{ spaceId: spc }])

    // The old note keeps everything it had; nothing points out of it anew.
    expect(await edges(old)).toEqual(
      [`mentions:${co}`, `tagged_in:${co}`].sort(),
    )
    expect(
      await db
        .select()
        .from(link)
        .where(and(eq(link.toEntityId, old), eq(link.relation, 'supersedes'))),
    ).toHaveLength(1)
  })

  it('refuses a note the actor cannot read', async () => {
    const hidden = await make('note', 'Hidden')
    const other = `other-${randomUUID().slice(0, 8)}`
    const { user } = await import('@spaces/db/schema/auth')
    await db
      .insert(user)
      .values({ id: other, name: 'Other', email: `${other}@example.test` })
    await db.insert(note).values({
      entityId: hidden,
      authorId: other,
      title: 'Hidden',
      kind: 'note',
      visibility: 'private',
    })
    const failure = await Effect.runPromise(
      Effect.flip(saveNoteAsNewVersionProgram(FIXTURE_ACTOR.id, hidden)),
    )
    expect(failure).toBeInstanceOf(NoteNotFound)
  })
})
