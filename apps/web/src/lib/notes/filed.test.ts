import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * The filed block of a space page (SPA-120).
 *
 * What it has to prove: a memo leads its space even when a scratch note was
 * touched this morning — before SPA-120 the query ordered by `updated_at`
 * alone and the memo sank; two memos still order among themselves by
 * recency, because there is no singleton memo (CONTEXT.md → Filed vs
 * referenced); and the visibility filter the extraction moved is the one
 * that was there — a teammate's private note never reaches the loader.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

async function aSpace(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, space } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'space', canonicalName: `Climate ${tag}` })
    .returning({ id: entity.id })
  await db.insert(space).values({
    entityId: ent.id,
    slug: `climate-${tag}`,
    path: `climate_${tag.replace(/-/g, '_')}`,
  })
  return ent.id
}

/** One note, filed into `inSpace`, with the shape the case needs. */
async function aNote(opts: {
  title: string
  authorId: string
  inSpace: string
  kind?: 'note' | 'memo' | 'scratch'
  visibility?: 'shared' | 'private'
  updatedAt?: Date
  bodyMd?: string
}): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, entitySpace, note } = await import('@spaces/db/schema')

  const [ent] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: opts.title })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: ent.id,
    title: opts.title,
    authorId: opts.authorId,
    kind: opts.kind ?? 'note',
    visibility: opts.visibility ?? 'shared',
    ...(opts.bodyMd ? { bodyMd: opts.bodyMd } : {}),
    ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
  })
  await db.insert(entitySpace).values({
    entityId: ent.id,
    spaceId: opts.inSpace,
    source: 'manual',
  })
  return ent.id
}

/** A second partner, so "someone else's private note" is a real row. */
async function anotherUser(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [row] = await db
    .insert(user)
    .values({
      id: `spa120-other-${tag}`,
      name: 'The Other Partner',
      email: `other-${tag}@spaces.test`,
    })
    .returning({ id: user.id })
  return row.id
}

describe('filedNotesProgram', () => {
  it('leads with the memo even when a plainer note is fresher', async () => {
    const { filedNotesProgram } = await import('./filed')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const spaceId = await aSpace(tag)

    // The oldest row of all, and still first: memo beats recency.
    const memo = await aNote({
      title: `Why climate ${tag}`,
      authorId: me,
      inSpace: spaceId,
      kind: 'memo',
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    })
    const fresh = await aNote({
      title: `Scratch ${tag}`,
      authorId: me,
      inSpace: spaceId,
      kind: 'scratch',
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    })

    const filed = await Effect.runPromise(filedNotesProgram(me, spaceId))
    expect(filed.map((f) => f.id)).toEqual([memo, fresh])
  })

  it('orders two memos among themselves by updatedAt desc', async () => {
    const { filedNotesProgram } = await import('./filed')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const spaceId = await aSpace(tag)

    const olderMemo = await aNote({
      title: `First take ${tag}`,
      authorId: me,
      inSpace: spaceId,
      kind: 'memo',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const newerMemo = await aNote({
      title: `Second take ${tag}`,
      authorId: me,
      inSpace: spaceId,
      kind: 'memo',
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    })
    const newestNote = await aNote({
      title: `Teardown ${tag}`,
      authorId: me,
      inSpace: spaceId,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    })

    // Both memos above the fresher note; between them, recency decides.
    const filed = await Effect.runPromise(filedNotesProgram(me, spaceId))
    expect(filed.map((f) => f.id)).toEqual([newerMemo, olderMemo, newestNote])
  })

  it('keeps someone else’s private note out, and mine in', async () => {
    const { filedNotesProgram } = await import('./filed')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const other = await anotherUser(tag)
    const spaceId = await aSpace(tag)

    const theirs = await aNote({
      title: `Their private filing ${tag}`,
      authorId: other,
      inSpace: spaceId,
      visibility: 'private',
    })
    const mine = await aNote({
      title: `My private filing ${tag}`,
      authorId: me,
      inSpace: spaceId,
      visibility: 'private',
    })
    const shared = await aNote({
      title: `Shared ${tag}`,
      authorId: other,
      inSpace: spaceId,
    })

    const filed = await Effect.runPromise(filedNotesProgram(me, spaceId))
    // Not the id, and — the actual leak — not the title either.
    expect(filed.map((f) => f.id)).not.toContain(theirs)
    expect(JSON.stringify(filed)).not.toContain('Their private')
    expect(new Set(filed.map((f) => f.id))).toEqual(new Set([mine, shared]))

    // Per reader, not a blanket "hide private": they see theirs, not mine.
    const theirFiled = await Effect.runPromise(
      filedNotesProgram(other, spaceId),
    )
    expect(new Set(theirFiled.map((f) => f.id))).toEqual(
      new Set([theirs, shared]),
    )
  })

  it('drops a note whose entity has been merged away', async () => {
    const { filedNotesProgram } = await import('./filed')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const spaceId = await aSpace(tag)

    const survivor = await aNote({
      title: `Survivor ${tag}`,
      authorId: me,
      inSpace: spaceId,
    })
    const merged = await aNote({
      title: `Merged away ${tag}`,
      authorId: me,
      inSpace: spaceId,
    })
    await db
      .update(entity)
      .set({ mergedIntoId: survivor })
      .where(eq(entity.id, merged))

    const filed = await Effect.runPromise(filedNotesProgram(me, spaceId))
    expect(filed.map((f) => f.id)).toEqual([survivor])
  })

  it('carries the snippet the page renders, without the Mentions block', async () => {
    const { filedNotesProgram } = await import('./filed')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const spaceId = await aSpace(tag)
    await aNote({
      title: `Bodied ${tag}`,
      authorId: me,
      inSpace: spaceId,
      bodyMd: 'The thesis   in\nbrief.\n\nMentions: [[Kestrel]]',
    })

    const filed = await Effect.runPromise(filedNotesProgram(me, spaceId))
    expect(filed.at(0)?.snippet).toBe('The thesis in brief.')
  })

  it('answers an empty list for a space nothing is filed into', async () => {
    const { filedNotesProgram } = await import('./filed')
    const tag = randomUUID().slice(0, 8)
    const filed = await Effect.runPromise(
      filedNotesProgram(await actorId(), await aSpace(tag)),
    )
    expect(filed).toEqual([])
  })
})
