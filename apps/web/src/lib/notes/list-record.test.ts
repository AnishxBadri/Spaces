import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * The two lanes of a record's Notes section (SPA-104).
 *
 * What the lanes have to prove: a note filed *and* mentioning appears once
 * under filed; a teammate's private note appears in neither lane, because
 * its title is what leaks and the filter is in SQL; memos pin to the top of
 * the filed lane through the one comparator; and a merged-away note stops
 * appearing at all.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

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

/** One note with the edges and the shape the case under test needs. */
async function aNote(opts: {
  title: string
  authorId: string
  kind?: 'note' | 'memo' | 'scratch'
  visibility?: 'shared' | 'private'
  updatedAt?: Date
  filedAgainst?: string
  mentions?: string
}): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, link, note } = await import('@spaces/db/schema')

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
    ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
  })
  if (opts.filedAgainst) {
    await db.insert(link).values({
      fromEntityId: ent.id,
      toEntityId: opts.filedAgainst,
      relation: 'tagged_in',
      source: 'manual',
    })
  }
  if (opts.mentions) {
    await db.insert(link).values({
      fromEntityId: ent.id,
      toEntityId: opts.mentions,
      relation: 'mentions',
      source: 'extracted',
    })
  }
  return ent.id
}

/** A second partner, so "someone else's private note" is a real row. */
async function anotherUser(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [row] = await db
    .insert(user)
    .values({
      id: `spa104-other-${tag}`,
      name: 'The Other Partner',
      email: `other-${tag}@spaces.test`,
    })
    .returning({ id: user.id })
  return row.id
}

describe('listRecordNotesProgram', () => {
  it('shows a note that is both filed and mentioning once, under filed', async () => {
    const { listRecordNotesProgram } = await import('./list-record')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const companyId = await aCompany(tag)

    const both = await aNote({
      title: `Filed and mentioning ${tag}`,
      authorId: me,
      filedAgainst: companyId,
      mentions: companyId,
    })
    const onlyMentions = await aNote({
      title: `Only mentioning ${tag}`,
      authorId: me,
      mentions: companyId,
    })

    const lanes = await Effect.runPromise(listRecordNotesProgram(me, companyId))
    expect(lanes.filed.map((f) => f.id)).toEqual([both])
    expect(lanes.mentions.map((m) => m.id)).toEqual([onlyMentions])
  })

  it('keeps someone else’s private note out of both lanes', async () => {
    const { listRecordNotesProgram } = await import('./list-record')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const other = await anotherUser(tag)
    const companyId = await aCompany(tag)

    const theirsFiled = await aNote({
      title: `Their private filing ${tag}`,
      authorId: other,
      visibility: 'private',
      filedAgainst: companyId,
    })
    const theirsMention = await aNote({
      title: `Their private mention ${tag}`,
      authorId: other,
      visibility: 'private',
      mentions: companyId,
    })
    const mine = await aNote({
      title: `My private filing ${tag}`,
      authorId: me,
      visibility: 'private',
      filedAgainst: companyId,
    })

    const lanes = await Effect.runPromise(listRecordNotesProgram(me, companyId))
    const seen = [...lanes.filed, ...lanes.mentions]
    // Not the ids, and — the actual leak — not the titles either.
    expect(seen.map((n) => n.id)).not.toContain(theirsFiled)
    expect(seen.map((n) => n.id)).not.toContain(theirsMention)
    expect(JSON.stringify(seen)).not.toContain('Their private')
    // My own private note is mine to see.
    expect(lanes.filed.map((f) => f.id)).toEqual([mine])

    // And the other partner sees theirs, not mine — the predicate is per
    // reader, not a blanket "hide private".
    const theirLanes = await Effect.runPromise(
      listRecordNotesProgram(other, companyId),
    )
    expect(theirLanes.filed.map((f) => f.id)).toEqual([theirsFiled])
    expect(theirLanes.mentions.map((m) => m.id)).toEqual([theirsMention])
  })

  it('pins memos to the top of the filed lane, then orders by updatedAt desc', async () => {
    const { listRecordNotesProgram } = await import('./list-record')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const companyId = await aCompany(tag)

    const oldNote = await aNote({
      title: `Old note ${tag}`,
      authorId: me,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      filedAgainst: companyId,
    })
    const newNote = await aNote({
      title: `New note ${tag}`,
      authorId: me,
      updatedAt: new Date('2026-06-01T00:00:00Z'),
      filedAgainst: companyId,
    })
    // The oldest row of all, and still first: memo beats recency.
    const memo = await aNote({
      title: `Memo ${tag}`,
      authorId: me,
      kind: 'memo',
      updatedAt: new Date('2025-01-01T00:00:00Z'),
      filedAgainst: companyId,
    })

    const lanes = await Effect.runPromise(listRecordNotesProgram(me, companyId))
    expect(lanes.filed.map((f) => f.id)).toEqual([memo, newNote, oldNote])
  })

  it('drops a note whose entity has been merged away', async () => {
    const { listRecordNotesProgram } = await import('./list-record')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const companyId = await aCompany(tag)

    const survivor = await aNote({
      title: `Survivor ${tag}`,
      authorId: me,
      filedAgainst: companyId,
    })
    const merged = await aNote({
      title: `Merged away ${tag}`,
      authorId: me,
      filedAgainst: companyId,
      mentions: companyId,
    })
    await db
      .update(entity)
      .set({ mergedIntoId: survivor })
      .where(eq(entity.id, merged))

    const lanes = await Effect.runPromise(listRecordNotesProgram(me, companyId))
    expect(lanes.filed.map((f) => f.id)).toEqual([survivor])
    expect(lanes.mentions).toEqual([])
  })

  it('answers two empty lanes for a record nothing points at', async () => {
    const { listRecordNotesProgram } = await import('./list-record')
    const tag = randomUUID().slice(0, 8)
    const lanes = await Effect.runPromise(
      listRecordNotesProgram(await actorId(), await aCompany(tag)),
    )
    expect(lanes).toEqual({ filed: [], mentions: [] })
  })
})

describe('byMemoThenRecent', () => {
  it('is a total order: memo first, then ISO updatedAt descending', async () => {
    const { byMemoThenRecent } = await import('./ordering')
    const rows = [
      { kind: 'note', updatedAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'scratch', updatedAt: '2026-03-01T00:00:00.000Z' },
      { kind: 'memo', updatedAt: '2020-01-01T00:00:00.000Z' },
      { kind: 'memo', updatedAt: '2026-09-01T00:00:00.000Z' },
    ] as const
    expect([...rows].sort(byMemoThenRecent).map((r) => r.updatedAt)).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ])
    // Equal rows compare equal, so the sort is stable on ties.
    expect(byMemoThenRecent(rows[2], rows[2])).toBe(0)
  })
})
