import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * Documents file into spaces through `entity_space` (SPA-19), against the
 * test database.
 *
 * The union `fileAgainst: {kind:'record'|'space', entityId}` replaced a bare
 * `attachTo: uuid` that wrote `link(tagged_in)` whatever it pointed at, so
 * the three things worth pinning are the ones that were expressible before
 * and must not be now: a space reached as a link target, a dedupe guard that
 * cannot see a space filing, and a delete that trips over the `entity_space`
 * row it never knew about.
 *
 * The server fns need a request context no test has, so — as
 * `source-class.test.ts` does — these call the helpers they delegate to in
 * `server/shared.ts`, which the client barrel does not re-export. Imports are
 * dynamic for the same reason as the rest of the DB-coupled suite:
 * `@spaces/db` builds its pool from `DATABASE_URL` at import time and
 * `vitest.setup.ts` rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

/** A company to file against. */
async function aCompany(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: `Ohmium ${tag}` })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

/** A space to file into — through the same helper `createSpace` uses. */
async function aSpace(tag: string): Promise<string> {
  const { createSpaceRow } = await import('./shared')
  return createSpaceRow(`Hydrogen ${tag}`, null, await actorId())
}

/**
 * Real bytes in the blob store, so the GC assertion is about a file that
 * exists rather than about a call that was made. The local driver is the
 * default and writes plain files under `<DATA_DIR>/blobs`; nothing here
 * needs the master key, which only signs URLs.
 */
async function aBlob(tag: string): Promise<string> {
  const { storage } = await import('#/lib/storage')
  const bytes = Buffer.from(`deck ${tag}\n`, 'utf8')
  const sha = createHash('sha256').update(bytes).digest('hex')
  await storage().put(sha, bytes, { mime: 'text/plain' })
  return sha
}

type Target =
  { kind: 'record'; entityId: string } | { kind: 'space'; entityId: string }

async function file(
  sha: string,
  tag: string,
  target: Target,
): Promise<{ id: string }> {
  const { fileDocumentRow } = await import('./shared')
  return fileDocumentRow({
    sha,
    filename: `deck-${tag}.pdf`,
    mime: 'application/pdf',
    sizeBytes: 1024,
    kind: 'deck',
    fileAgainst: target,
    actorId: await actorId(),
  })
}

/** Both edge tables, for one document. */
async function edgesOf(
  documentId: string,
): Promise<{ links: Array<string>; spaces: Array<string> }> {
  const { db } = await import('@spaces/db')
  const { entitySpace, link } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const links = await db
    .select({ to: link.toEntityId, relation: link.relation })
    .from(link)
    .where(eq(link.fromEntityId, documentId))
  const spaces = await db
    .select({ space: entitySpace.spaceId })
    .from(entitySpace)
    .where(eq(entitySpace.entityId, documentId))
  return { links: links.map((r) => r.to), spaces: spaces.map((r) => r.space) }
}

describe('filing a document into a space', () => {
  it('writes one entity_space row and no link row', async () => {
    const { db } = await import('@spaces/db')
    const { entitySpace } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const tag = randomUUID().slice(0, 8)

    const spaceId = await aSpace(tag)
    const { id } = await file(await aBlob(tag), tag, {
      kind: 'space',
      entityId: spaceId,
    })

    const edges = await edgesOf(id)
    expect(edges.spaces).toEqual([spaceId])
    expect(edges.links).toEqual([])

    // The provenance every other member of a space carries: a person put it
    // there, so `manual` with the actor, not an unattributed row.
    const row = (
      await db
        .select({
          source: entitySpace.source,
          createdBy: entitySpace.createdBy,
        })
        .from(entitySpace)
        .where(eq(entitySpace.entityId, id))
    ).at(0)
    expect(row?.source).toBe('manual')
    expect(row?.createdBy).toBe(await actorId())
  })

  it('puts document.filed on the space in the activity log', async () => {
    const { db } = await import('@spaces/db')
    const { activity } = await import('@spaces/db/schema/activity')
    const { and, eq } = await import('drizzle-orm')
    const tag = randomUUID().slice(0, 8)

    const spaceId = await aSpace(tag)
    const { id } = await file(await aBlob(tag), tag, {
      kind: 'space',
      entityId: spaceId,
    })

    const rows = await db
      .select({ verb: activity.verb, subject: activity.subjectEntityId })
      .from(activity)
      .where(
        and(
          eq(activity.objectEntityId, id),
          eq(activity.verb, 'document.filed'),
        ),
      )
    expect(rows).toEqual([{ verb: 'document.filed', subject: spaceId }])
  })

  it('refuses a space as a record target, and a record as a space target', async () => {
    const tag = randomUUID().slice(0, 8)
    const sha = await aBlob(tag)
    const spaceId = await aSpace(tag)
    const companyId = await aCompany(tag)

    await expect(
      file(sha, tag, { kind: 'record', entityId: spaceId }),
    ).rejects.toThrow(/filed into, not against/)
    await expect(
      file(sha, tag, { kind: 'space', entityId: companyId }),
    ).rejects.toThrow(/entity_space/)

    // A document is not a record either — that edge would be a mention.
    const doc = await file(sha, tag, { kind: 'record', entityId: companyId })
    await expect(
      file(sha, tag, { kind: 'record', entityId: doc.id }),
    ).rejects.toThrow(/not against another document/)
  })
})

describe('the dedupe guard', () => {
  it('sees a second filing on both edge kinds', async () => {
    const { existingDocumentFiling } = await import('./shared')
    const tag = randomUUID().slice(0, 8)
    const sha = await aBlob(tag)

    const companyId = await aCompany(tag)
    const spaceId = await aSpace(tag)

    expect(
      await existingDocumentFiling(sha, {
        kind: 'record',
        entityId: companyId,
      }),
    ).toBe(null)

    const onCompany = await file(sha, tag, {
      kind: 'record',
      entityId: companyId,
    })
    expect(
      await existingDocumentFiling(sha, {
        kind: 'record',
        entityId: companyId,
      }),
    ).toBe(onCompany.id)

    // The half that was broken: the old guard joined `link` only, so this
    // read answered null forever and every re-drop into a space made a row.
    expect(
      await existingDocumentFiling(sha, { kind: 'space', entityId: spaceId }),
    ).toBe(null)
    const inSpace = await file(sha, tag, { kind: 'space', entityId: spaceId })
    expect(
      await existingDocumentFiling(sha, { kind: 'space', entityId: spaceId }),
    ).toBe(inSpace.id)
  })

  it('keeps company-then-space as two rows on one blob (§3.4)', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const tag = randomUUID().slice(0, 8)
    const sha = await aBlob(tag)

    const onCompany = await file(sha, tag, {
      kind: 'record',
      entityId: await aCompany(tag),
    })
    const inSpace = await file(sha, tag, {
      kind: 'space',
      entityId: await aSpace(tag),
    })
    expect(inSpace.id).not.toBe(onCompany.id)

    const rows = await db
      .select({ id: document.entityId })
      .from(document)
      .where(eq(document.blobSha, sha))
    expect(rows.map((r) => r.id).sort()).toEqual(
      [onCompany.id, inSpace.id].sort(),
    )
  })
})

describe('deleting a filed document', () => {
  it('clears both edge kinds and GCs the blob only when unshared', async () => {
    const { db } = await import('@spaces/db')
    const { document, entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { storage } = await import('#/lib/storage')
    const { deleteDocumentWithBlobGc } = await import('./shared')
    const tag = randomUUID().slice(0, 8)
    const sha = await aBlob(tag)

    const companyId = await aCompany(tag)
    const spaceId = await aSpace(tag)
    const onCompany = await file(sha, tag, {
      kind: 'record',
      entityId: companyId,
    })
    const inSpace = await file(sha, tag, { kind: 'space', entityId: spaceId })

    // The space-filed one first: before SPA-77's registry walk this was the
    // delete that raised an entity_space foreign-key violation.
    await deleteDocumentWithBlobGc(inSpace.id)
    expect(await edgesOf(inSpace.id)).toEqual({ links: [], spaces: [] })
    expect(
      await db
        .select({ id: entity.id })
        .from(entity)
        .where(eq(entity.id, inSpace.id)),
    ).toEqual([])
    // One document row still shares the digest, so the bytes stay.
    expect(await storage().exists(sha)).toBe(true)

    await deleteDocumentWithBlobGc(onCompany.id)
    expect(await edgesOf(onCompany.id)).toEqual({ links: [], spaces: [] })
    expect(
      await db
        .select({ id: document.entityId })
        .from(document)
        .where(eq(document.blobSha, sha)),
    ).toEqual([])
    expect(await storage().exists(sha)).toBe(false)
  })
})
