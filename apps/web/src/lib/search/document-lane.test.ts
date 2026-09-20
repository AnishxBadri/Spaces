import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The note body's @ menu can reach a document (SPA-27).
 *
 * `entitySearchRows`' default lane used to end `ne(entity.kind, 'document')`,
 * which is what made the mention chip the spec calls built impossible to
 * insert. The note editor is the only caller that omits `kinds`, so this is
 * the one lane that widened; the callers that name their kinds are pinned
 * here too, because "documents are now offered everywhere" would be the
 * regression that matters.
 *
 * `searchEntities` itself needs a request context no test has, so these drive
 * the query it is a thin wrapper around — the same seam `rename.test.ts`
 * uses. Imports are dynamic like the rest of the DB-coupled suite:
 * `@spaces/db` builds its pool from `DATABASE_URL` at import time and
 * `vitest.setup.ts` rewrites it per file.
 */

const actorId = async () => {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

/** A document entity, the way an upload leaves one behind. */
const aDocument = async (filename: string) => {
  const { db } = await import('@spaces/db')
  const { document, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: filename })
    .returning({ id: entity.id })
  await db.insert(document).values({
    entityId: ent.id,
    filename,
    mime: 'application/pdf',
    sizeBytes: 1024,
  })
  return ent.id
}

/** A note by someone else, at a given visibility. */
const aNote = async (title: string, visibility: 'shared' | 'private') => {
  const { db } = await import('@spaces/db')
  const { entity, note } = await import('@spaces/db/schema')
  const { user } = await import('@spaces/db/schema/auth')
  const [other] = await db
    .insert(user)
    .values({
      id: randomUUID(),
      name: 'Other Partner',
      email: `${randomUUID()}@fund.example`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: user.id })
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: title })
    .returning({ id: entity.id })
  await db
    .insert(note)
    .values({ entityId: ent.id, title, authorId: other.id, visibility })
  return ent.id
}

describe('the mention menu over documents', () => {
  it('offers a document to the lane that names no kinds', async () => {
    const { entitySearchRows } = await import('./rows')
    const tag = randomUUID().slice(0, 8)
    const docId = await aDocument(`Ohmium Series B deck ${tag}.pdf`)

    const hits = await entitySearchRows(await actorId(), {
      q: `Ohmium Series B deck ${tag}`,
    })

    const hit = hits.find((h) => h.id === docId)
    expect(hit).toBeTruthy()
    // The badge the suggestion menu prints is `kind`, verbatim.
    expect(hit?.kind).toBe('document')
  })

  it('still leaves a document out when the caller names its kinds', async () => {
    const { entitySearchRows } = await import('./rows')
    const tag = randomUUID().slice(0, 8)
    const docId = await aDocument(`Ohmium cap table ${tag}.xlsx`)

    // Exactly what the record-filing picker and the value editor pass.
    const hits = await entitySearchRows(await actorId(), {
      q: `Ohmium cap table ${tag}`,
      kinds: ['company', 'person', 'deal', 'custom'],
    })

    expect(hits.map((h) => h.id)).not.toContain(docId)
  })

  it('keeps another author private note out of the widened lane', async () => {
    const { entitySearchRows } = await import('./rows')
    const tag = randomUUID().slice(0, 8)
    const hidden = await aNote(`Ohmium diligence ${tag}`, 'private')
    const shared = await aNote(`Ohmium diligence ${tag} shared`, 'shared')

    const hits = await entitySearchRows(await actorId(), {
      q: `Ohmium diligence ${tag}`,
    })

    const ids = hits.map((h) => h.id)
    expect(ids).not.toContain(hidden)
    expect(ids).toContain(shared)
  })
})
