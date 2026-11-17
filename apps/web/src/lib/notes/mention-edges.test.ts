import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

/**
 * A note's rail lists, against the test database. Both directions hide a
 * private note from anyone but its author, and both drop a merged-away
 * record, so a private note's title never reaches a teammate's rail.
 * Imports are dynamic: `@spaces/db` builds its pool from `DATABASE_URL` at
 * import time, and the test setup rewrites it per file.
 */

async function makeUser(name: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const id = `member-${randomUUID().slice(0, 8)}`
  await db.insert(user).values({
    id,
    name,
    email: `${id}@fund.example`,
    emailVerified: true,
  })
  return id
}

async function makeNote(
  title: string,
  authorId: string,
  visibility: 'shared' | 'private',
): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, note } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: title, createdBy: authorId })
    .returning({ id: entity.id })
  await db
    .insert(note)
    .values({ entityId: ent.id, title, authorId, visibility })
  return ent.id
}

async function makeCompany(name: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

async function mention(fromId: string, toId: string): Promise<void> {
  const { db } = await import('@spaces/db')
  const { link } = await import('@spaces/db/schema')
  await db
    .insert(link)
    .values({ fromEntityId: fromId, toEntityId: toId, relation: 'mentions' })
}

async function mergeAway(id: string, intoId: string): Promise<void> {
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  await db.update(entity).set({ mergedIntoId: intoId }).where(eq(entity.id, id))
}

async function edges(viewerId: string, noteId: string) {
  const { noteMentionEdgesProgram } = await import('./mention-edges')
  return Effect.runPromise(noteMentionEdgesProgram(viewerId, noteId))
}

describe('noteMentionEdgesProgram', () => {
  it("leaves a private note that mentions a shared one out of a teammate's Mentioned in", async () => {
    const a = await makeUser('Anish')
    const b = await makeUser('Priya')
    const shared = await makeNote('Shared thesis', b, 'shared')
    const secret = await makeNote('A private take on Acme', a, 'private')
    const open = await makeNote('A shared follow-up', a, 'shared')
    await mention(secret, shared)
    await mention(open, shared)

    const forB = await edges(b, shared)
    expect(forB.backlinks.map((r) => r.fromId)).toEqual([open])
    expect(JSON.stringify(forB)).not.toContain('A private take on Acme')

    // The author still sees their own note.
    const forA = await edges(a, shared)
    expect(forA.backlinks.map((r) => r.fromId)).toEqual([secret, open])
  })

  it('drops a merged-away source from Mentioned in, as from Mentions', async () => {
    const a = await makeUser('Anish')
    const target = await makeNote('Target', a, 'shared')
    const survivor = await makeCompany('Acme')
    const merged = await makeCompany('Acme Inc')
    await mention(merged, target)
    await mention(survivor, target)
    await mention(target, merged)
    await mergeAway(merged, survivor)

    const got = await edges(a, target)
    expect(got.backlinks.map((r) => r.fromId)).toEqual([survivor])
    expect(got.mentions).toEqual([])
  })

  it("hides a private note the body mentions from a teammate's Mentions", async () => {
    const a = await makeUser('Anish')
    const b = await makeUser('Priya')
    const shared = await makeNote('Shared thesis', b, 'shared')
    const secret = await makeNote('A private take', a, 'private')
    await mention(shared, secret)

    expect((await edges(b, shared)).mentions).toEqual([])
    expect((await edges(a, shared)).mentions.map((r) => r.id)).toEqual([secret])
  })
})
