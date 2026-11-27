import { describe, expect, it } from 'vitest'

/**
 * `findInDocumentProgram` against the test database: a query over a file's
 * stored text comes back as hits grouped by the page they are on, the
 * marker lines never counting, and nothing for a reader the file is private
 * from. Dynamic imports: `@spaces/db` builds its pool from `DATABASE_URL` at
 * import time and the vitest setup rewrites it per file.
 */

describe('findInDocumentProgram', () => {
  it('returns the hits grouped by page, and null for a reader who may not read the file', async () => {
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { document, entity } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { findInDocumentProgram } = await import('./find')
    const author = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
    if (author === undefined) throw new Error('the seed has no user')
    const id = (
      await db
        .insert(entity)
        .values({ kind: 'document', canonicalName: 'deck.pdf' })
        .returning({ id: entity.id })
    ).at(0)?.id
    if (id === undefined) throw new Error('no entity')
    await db.insert(document).values({
      entityId: id,
      filename: 'deck.pdf',
      extractionStatus: 'done',
      authorId: author.id,
      visibility: 'private',
      extractedText: [
        '[Page 1]\nLeases under management',
        '[Page 3]\nLEASES grew; leases renew\n[Page 9] is a line of text',
        '[Page 4]\nUnit economics',
        '[Page 5]\nThe leases book',
      ].join('\n\n'),
    })
    const find = (viewer: string, query: string) =>
      Effect.runPromise(findInDocumentProgram({ id: viewer }, id, query))

    expect(await find(author.id, 'leases')).toEqual({
      total: 4,
      pages: [
        { page: 1, hits: 1 },
        { page: 3, hits: 2 },
        { page: 5, hits: 1 },
      ],
      unit: 'page',
    })
    expect(await find(author.id, 'page')).toEqual({
      total: 1,
      pages: [{ page: 3, hits: 1 }],
      unit: 'page',
    })
    expect(await find('someone-else', 'leases')).toBeNull()
  })
})
