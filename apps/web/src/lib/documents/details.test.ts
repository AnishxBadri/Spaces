import { describe, expect, it } from 'vitest'

/**
 * `documentDetailsProgram` against the test database: the chunk count the
 * Remove confirm prints, the words and pages the viewer's TEXT line reads,
 * and the notes that mention the file — a private note only for its author.
 * Dynamic imports: `@spaces/db` builds its pool from `DATABASE_URL` at import
 * time and the vitest setup rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

async function anEntity(
  kind: 'document' | 'note',
  name: string,
): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')
  const [row] = await db
    .insert(entity)
    .values({ kind, canonicalName: name })
    .returning({ id: entity.id })
  return row.id
}

async function aNoteMentioning(
  documentId: string,
  title: string,
  visibility: 'shared' | 'private',
): Promise<string> {
  const { db } = await import('@spaces/db')
  const { link, note } = await import('@spaces/db/schema')
  const author = await actorId()
  const id = await anEntity('note', title)
  await db
    .insert(note)
    .values({ entityId: id, title, authorId: author, visibility })
  await db.insert(link).values({
    fromEntityId: id,
    toEntityId: documentId,
    relation: 'mentions',
    createdBy: author,
  })
  return id
}

async function details(viewer: string, id: string) {
  const { Effect } = await import('effect')
  const { documentDetailsProgram } = await import('./details')
  return Effect.runPromise(documentDetailsProgram({ id: viewer }, id))
}

describe('documentDetailsProgram', () => {
  it('counts chunks, words and pages, and lists the notes the viewer may read', async () => {
    const { db } = await import('@spaces/db')
    const { chunk, document } = await import('@spaces/db/schema')
    const id = await anEntity('document', 'deck.pdf')
    await db.insert(document).values({
      entityId: id,
      filename: 'deck.pdf',
      extractedText: '  Homes under management \n grew 3.2x  ',
      extractionStatus: 'done',
    })
    await db.insert(chunk).values([
      { entityId: id, sourceKind: 'document', idx: 0, text: 'a', page: 1 },
      { entityId: id, sourceKind: 'document', idx: 1, text: 'b', page: 14 },
    ])
    const shared = await aNoteMentioning(id, 'Flent seed — IC note', 'shared')
    const secret = await aNoteMentioning(id, 'My own notes', 'private')

    const mine = await details(await actorId(), id)
    expect(mine).toMatchObject({ chunks: 2, words: 5, pages: 14, sha: null })
    expect(mine?.mentionedIn.map((m) => m.id).sort()).toEqual(
      [shared, secret].sort(),
    )

    const theirs = await details('someone-else', id)
    expect(theirs?.mentionedIn.map((m) => m.name)).toEqual([
      'Flent seed — IC note',
    ])
  })

  it('walks the replace chain both ways, newest first, leaving out a version the viewer may not read', async () => {
    const { db } = await import('@spaces/db')
    const { document, link } = await import('@spaces/db/schema')
    const actor = await actorId()
    const file = async (
      name: string,
      createdAt: string,
      visibility: 'shared' | 'private' = 'shared',
    ) => {
      const id = await anEntity('document', name)
      await db.insert(document).values({
        entityId: id,
        filename: name,
        uploadedBy: actor,
        authorId: actor,
        visibility,
        createdAt: new Date(createdAt),
      })
      return id
    }
    const v1 = await file('deck v1.pdf', '2026-09-01T10:00:00Z')
    const v2 = await file('deck v2.pdf', '2026-09-20T10:00:00Z')
    const v3 = await file('deck v3.pdf', '2026-10-05T10:00:00Z', 'private')
    const supersedes = (newer: string, older: string) =>
      db.insert(link).values({
        fromEntityId: newer,
        toEntityId: older,
        relation: 'supersedes',
        createdBy: actor,
      })
    await supersedes(v2, v1)
    await supersedes(v3, v2)

    // Opened on the middle one, the walk reaches both ends.
    const mine = await details(actor, v2)
    expect(mine?.versions.map((v) => [v.name, v.current])).toEqual([
      ['deck v3.pdf', false],
      ['deck v2.pdf', true],
      ['deck v1.pdf', false],
    ])
    expect(mine?.versions[0]?.at).toBe('2026-10-05T10:00:00.000Z')

    const theirs = await details('someone-else', v1)
    expect(theirs?.versions.map((v) => v.name)).toEqual([
      'deck v2.pdf',
      'deck v1.pdf',
    ])
  })

  it('reads nothing for a file with no text, and null for no file', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const id = await anEntity('document', 'scan.pdf')
    await db.insert(document).values({ entityId: id, filename: 'scan.pdf' })
    expect(await details(await actorId(), id)).toMatchObject({
      chunks: 0,
      words: null,
      pages: null,
      mentionedIn: [],
    })
    expect(
      await details(await actorId(), '00000000-0000-4000-8000-00000000dead'),
    ).toBeNull()
  })
})
