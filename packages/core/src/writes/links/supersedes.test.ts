import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { and, eq, or } from 'drizzle-orm'
import { db } from '@spaces/db'
import { chunk, document, entity, link, note } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import {
  SupersedesRefused,
  markNewerVersionProgram,
  supersedesMessage,
} from './supersedes'

async function me() {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('fixture user missing')
  return row.id
}

async function doc(name: string) {
  const e = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!e) throw new Error('entity insert returned no row')
  // Exempt from the one-writer rule: a fixture with text already read.
  await db.insert(document).values({
    entityId: e.id,
    filename: name,
    kind: 'deck',
    sourceClass: 'manual',
    extractionStatus: 'done',
  })
  await db
    .insert(chunk)
    .values({ entityId: e.id, sourceKind: 'document', idx: 0, text: name })
  return e.id
}

async function privateNote(authorId: string) {
  const e = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: 'Private' })
      .returning({ id: entity.id })
  ).at(0)
  if (!e) throw new Error('entity insert returned no row')
  await db.insert(note).values({
    entityId: e.id,
    authorId,
    title: 'Private',
    kind: 'note',
    visibility: 'private',
  })
  return e.id
}

const refusal = async (edge: Parameters<typeof markNewerVersionProgram>[0]) => {
  const failure = await Effect.runPromise(
    Effect.flip(markNewerVersionProgram(edge)),
  )
  return failure instanceof SupersedesRefused ? failure.reason : null
}

describe('markNewerVersionProgram', () => {
  it('writes one supersedes link, newer → older, and nothing else', async () => {
    const actorId = await me()
    const older = await doc('deck-v2.pdf')
    const newer = await doc('deck-v3.pdf')
    const before = await db.select({ id: link.id }).from(link)

    const first = await Effect.runPromise(
      markNewerVersionProgram({ newerId: newer, olderId: older, actorId }),
    )
    expect(first).toEqual({ written: true })

    const edges = await db
      .select()
      .from(link)
      .where(or(eq(link.fromEntityId, newer), eq(link.toEntityId, newer)))
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      fromEntityId: newer,
      toEntityId: older,
      relation: 'supersedes',
      source: 'manual',
      createdBy: actorId,
    })
    expect(await db.select({ id: link.id }).from(link)).toHaveLength(
      before.length + 1,
    )
    // Both rows and their chunks stay.
    for (const id of [older, newer]) {
      expect(
        await db.select().from(document).where(eq(document.entityId, id)),
      ).toHaveLength(1)
      expect(
        await db.select().from(chunk).where(eq(chunk.entityId, id)),
      ).toHaveLength(1)
    }

    // The same pair again is a no-op.
    const second = await Effect.runPromise(
      markNewerVersionProgram({ newerId: newer, olderId: older, actorId }),
    )
    expect(second).toEqual({ written: false })
    expect(
      await db
        .select()
        .from(link)
        .where(
          and(eq(link.fromEntityId, newer), eq(link.relation, 'supersedes')),
        ),
    ).toHaveLength(1)
  })

  it('refuses itself, the reverse of an edge, a mixed pair and an unreadable note', async () => {
    const actorId = await me()
    const a = await doc('a.pdf')
    const b = await doc('b.pdf')
    await Effect.runPromise(
      markNewerVersionProgram({ newerId: b, olderId: a, actorId }),
    )
    expect(await refusal({ newerId: a, olderId: a, actorId })).toBe('self')
    expect(await refusal({ newerId: a, olderId: b, actorId })).toBe('reverse')

    const theirs = await db
      .insert(user)
      .values({
        id: `supersedes-other-${crypto.randomUUID().slice(0, 8)}`,
        name: 'Other',
        email: `other-${crypto.randomUUID().slice(0, 8)}@example.test`,
      })
      .returning({ id: user.id })
    const hidden = await privateNote(theirs[0].id)
    const mine = await privateNote(actorId)
    expect(await refusal({ newerId: mine, olderId: a, actorId })).toBe(
      'kind_mismatch',
    )
    expect(await refusal({ newerId: mine, olderId: hidden, actorId })).toBe(
      'not_found',
    )
    expect(
      supersedesMessage(new SupersedesRefused({ reason: 'reverse' })),
    ).toBe('That one is already the newer version of this')
  })
})
