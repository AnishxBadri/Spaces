import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The space page's Sources lane (SPA-44), against the test database.
 *
 * What is worth pinning is the half the Files-tab query cannot answer: a
 * space filing is an `entity_space` row, not a `link(tagged_in)` one, so a
 * lane keyed on `link` would have returned nothing for every space that
 * ever had a source. The rest is the row shape the section renders —
 * newest first, the uploader resolved to a name, the snippet collapsed and
 * capped, and a merged-away document gone.
 *
 * Dynamic imports for the reason the rest of the DB-coupled suite uses
 * them: `@spaces/db` builds its pool from `DATABASE_URL` at import time and
 * `vitest.setup.ts` rewrites it per file. The program is called directly —
 * `getSpace` needs a request no test has, which is why the query lives
 * outside `lib/server/` at all.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

async function aSpace(tag: string): Promise<string> {
  const { createSpaceRow } = await import('#/lib/server/shared')
  return createSpaceRow(`Hydrogen ${tag}`, null, await actorId())
}

async function aBlob(tag: string): Promise<string> {
  const { storage } = await import('#/lib/storage')
  const bytes = Buffer.from(`deck ${tag}\n`, 'utf8')
  const sha = createHash('sha256').update(bytes).digest('hex')
  await storage().put(sha, bytes, { mime: 'text/plain' })
  return sha
}

async function fileIntoSpace(
  spaceId: string,
  filename: string,
  sha: string,
): Promise<string> {
  const { fileDocumentRow } = await import('#/lib/server/shared')
  const { id } = await fileDocumentRow({
    sha,
    filename,
    mime: 'application/pdf',
    sizeBytes: 2048,
    kind: 'deck',
    fileAgainst: { kind: 'space', entityId: spaceId },
    actorId: await actorId(),
  })
  return id
}

async function sourcesOf(spaceId: string) {
  const { Effect } = await import('effect')
  const { spaceSourcesProgram } = await import('./space-sources')
  return Effect.runPromise(spaceSourcesProgram(spaceId))
}

describe('spaceSourcesProgram', () => {
  it('reads back a document filed into the space, newest first', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)

    expect(await sourcesOf(spaceId)).toEqual([])

    const first = await fileIntoSpace(
      spaceId,
      `older-${tag}.pdf`,
      await aBlob(`a-${tag}`),
    )
    const second = await fileIntoSpace(
      spaceId,
      `newer-${tag}.pdf`,
      await aBlob(`b-${tag}`),
    )

    const rows = await sourcesOf(spaceId)
    expect(rows.map((r) => r.id)).toEqual([second, first])

    const row = rows[0]
    expect(row.filename).toBe(`newer-${tag}.pdf`)
    expect(row.kind).toBe('deck')
    expect(row.sizeBytes).toBe(2048)
    expect(row.mime).toBe('application/pdf')
    // Freshly filed: the extract job has not run, and the row says so
    // rather than pretending the file is textless.
    expect(row.extractionStatus).toBe('pending')
    expect(row.extractionError).toBeNull()
    expect(row.snippet).toBeNull()
    expect(row.uploadedByName).toBeTruthy()
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.sinceMs).toBeGreaterThanOrEqual(0)
  })

  it('collapses the snippet and caps it at 200 characters', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const tag = randomUUID().slice(0, 8)

    const spaceId = await aSpace(tag)
    const id = await fileIntoSpace(spaceId, `deck-${tag}.pdf`, await aBlob(tag))
    await db
      .update(document)
      .set({
        extractionStatus: 'done',
        extractedText: `  electrolyser\n\n stack  ${'x'.repeat(400)}`,
      })
      .where(eq(document.entityId, id))

    const [row] = await sourcesOf(spaceId)
    // `left(…, 200)` cuts the raw column and the collapse runs after, so a
    // snippet is never longer than 200 and is shorter by whatever runs of
    // whitespace the cut contained. The Files tab's is the same arithmetic.
    expect(row.snippet?.startsWith('electrolyser stack x')).toBe(true)
    expect(row.snippet?.length).toBeLessThanOrEqual(200)
    expect(row.snippet?.length).toBeGreaterThan(180)
    expect(row.snippet).not.toMatch(/\s\s|\n/)
  })

  it('drops a document that was merged away', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const tag = randomUUID().slice(0, 8)

    const spaceId = await aSpace(tag)
    const kept = await fileIntoSpace(
      spaceId,
      `kept-${tag}.pdf`,
      await aBlob(`k-${tag}`),
    )
    const merged = await fileIntoSpace(
      spaceId,
      `gone-${tag}.pdf`,
      await aBlob(`m-${tag}`),
    )

    await db
      .update(entity)
      .set({ mergedIntoId: kept })
      .where(eq(entity.id, merged))

    expect((await sourcesOf(spaceId)).map((r) => r.id)).toEqual([kept])
  })

  it('does not see a document filed against a record', async () => {
    const { db } = await import('@spaces/db')
    const { company, entity } = await import('@spaces/db/schema')
    const { fileDocumentRow } = await import('#/lib/server/shared')
    const tag = randomUUID().slice(0, 8)

    const spaceId = await aSpace(tag)
    const [ent] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `Ohmium ${tag}` })
      .returning({ id: entity.id })
    await db.insert(company).values({ entityId: ent.id })

    await fileDocumentRow({
      sha: await aBlob(tag),
      filename: `deck-${tag}.pdf`,
      mime: 'application/pdf',
      sizeBytes: 2048,
      kind: 'deck',
      fileAgainst: { kind: 'record', entityId: ent.id },
      actorId: await actorId(),
    })

    // `link(tagged_in)` is the record's edge and never a space's: a lane
    // keyed on it would have shown this row here.
    expect(await sourcesOf(spaceId)).toEqual([])
  })
})
