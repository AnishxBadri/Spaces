import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

// The test databases carry no `pgboss` schema, and the birth of a document
// enqueues extraction — see `#/test/queue-stub`.
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * The `/documents` shelf query (SPA-58), against the test database.
 *
 * What is worth pinning is the half `listRecordDocuments` cannot answer. That
 * one starts at `link` and returns **one row per filing**, so a deck filed
 * against a company and a deal is two rows; this returns one row per document
 * with both filings folded into it. Everything below is that difference, plus
 * the two exclusions the shelf has to get right — a merged-away document is
 * not a document, and a chip pointing at a merged-away target would route to
 * a page the merge redirects away from.
 *
 * Dynamic imports for the reason the rest of the DB-coupled suite uses them:
 * `@spaces/db` builds its pool from `DATABASE_URL` at import time and
 * `vitest.setup.ts` rewrites it per file. The program is called directly —
 * `listDocuments` needs a request no test has, which is why the query lives
 * outside `lib/server/` at all.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

async function aBlob(tag: string): Promise<string> {
  const { storage } = await import('#/lib/storage')
  const bytes = Buffer.from(`deck ${tag}\n`, 'utf8')
  const sha = createHash('sha256').update(bytes).digest('hex')
  await storage().put(sha, bytes, { mime: 'text/plain' })
  return sha
}

async function aCompany(name: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

async function aSpace(name: string): Promise<string> {
  const { createSpaceRow } = await import('#/lib/server/shared')
  return createSpaceRow(name, null, await actorId())
}

/** File a document at one target and return its id. */
async function fileDocument(
  filename: string,
  sha: string,
  target: { kind: 'record' | 'space'; entityId: string },
): Promise<string> {
  const { Effect } = await import('effect')
  const { birthDocumentProgram } = await import('#/lib/documents/birth')
  const { id } = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: sha,
      filename,
      mime: 'application/pdf',
      sizeBytes: 2048,
      kind: 'deck',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: [target],
      actor: { userId: await actorId() },
    }),
  )
  return id
}

/** A second filing on an existing document row — the N-places rule (§3.4). */
async function alsoFileAgainst(documentId: string, entityId: string) {
  const { db } = await import('@spaces/db')
  const { link } = await import('@spaces/db/schema')
  await db.insert(link).values({
    fromEntityId: documentId,
    toEntityId: entityId,
    relation: 'tagged_in',
    createdBy: await actorId(),
  })
}

async function mergeAway(entityId: string, intoId: string) {
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  await db
    .update(entity)
    .set({ mergedIntoId: intoId })
    .where(eq(entity.id, entityId))
}

async function shelf() {
  const { Effect } = await import('effect')
  const { listDocumentsProgram } = await import('./shelf')
  return Effect.runPromise(listDocumentsProgram())
}

/**
 * The shelf is the whole workspace by design, and truncation is per test
 * *file* rather than per test (CLAUDE.md → Isolation), so every case below
 * tags its fixtures and reads back only its own. Asserting on the bare list
 * would make each test depend on the ones before it.
 */
async function shelfTagged(tag: string) {
  return (await shelf()).filter((r) => r.filename.includes(tag))
}

describe('listDocumentsProgram', () => {
  it('is empty before anything is filed', async () => {
    expect(await shelf()).toEqual([])
  })

  it('folds two filings into one row per document', async () => {
    const tag = randomUUID().slice(0, 8)
    const acme = await aCompany(`Acme ${tag}`)
    const other = await aCompany(`Other ${tag}`)
    const docId = await fileDocument(`deck-${tag}.pdf`, await aBlob(tag), {
      kind: 'record',
      entityId: acme,
    })
    await alsoFileAgainst(docId, other)

    const rows = await shelfTagged(tag)
    // One row, not two: the whole difference from `listRecordDocuments`.
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(docId)
    expect(rows[0].filename).toBe(`deck-${tag}.pdf`)
    expect(rows[0].records.map((r) => r.name).sort()).toEqual([
      `Acme ${tag}`,
      `Other ${tag}`,
    ])
    // `kind` and `objectSlug` are what `recordPath` routes a chip on.
    expect(rows[0].records.every((r) => r.kind === 'company')).toBe(true)
    expect(rows[0].spaces).toEqual([])
    expect(rows[0].sizeBytes).toBe(2048)
    expect(rows[0].uploadedByName).toBeTruthy()
    expect(rows[0].sinceMs).toBeGreaterThanOrEqual(0)
  })

  it('includes a space-filed document, with its space', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(`Hydrogen ${tag}`)
    const docId = await fileDocument(`memo-${tag}.pdf`, await aBlob(tag), {
      kind: 'space',
      entityId: spaceId,
    })

    const rows = await shelfTagged(tag)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(docId)
    // Filing into a space is `entity_space`, never `link(tagged_in)` — a
    // shelf keyed on `link` alone would have shown nothing here.
    expect(rows[0].spaces).toEqual([{ id: spaceId, name: `Hydrogen ${tag}` }])
    expect(rows[0].records).toEqual([])
  })

  it('drops a merged-away document and a merged-away target', async () => {
    const tag = randomUUID().slice(0, 8)
    const survivor = await aCompany(`Survivor ${tag}`)
    const absorbed = await aCompany(`Absorbed ${tag}`)

    const kept = await fileDocument(`kept-${tag}.pdf`, await aBlob(`k${tag}`), {
      kind: 'record',
      entityId: survivor,
    })
    await alsoFileAgainst(kept, absorbed)

    const gone = await fileDocument(`gone-${tag}.pdf`, await aBlob(`g${tag}`), {
      kind: 'record',
      entityId: survivor,
    })
    await mergeAway(gone, kept)
    await mergeAway(absorbed, survivor)

    const rows = await shelfTagged(tag)
    expect(rows.map((r) => r.id)).toEqual([kept])
    // The absorbed company is still an edge in `link`; it is not a chip.
    expect(rows[0].records.map((r) => r.name)).toEqual([`Survivor ${tag}`])
  })

  it('leaves an ordinary upload with no storage-source provenance', async () => {
    // The five columns of §11 delta 1 are null on every document until a
    // storage-source plugin files one (SPA-78), and this row must read
    // exactly as it read before they existed: three nulls, not three empty
    // strings and not a placeholder dash — the Source column prints the
    // origin on its own when `sourcePath` is null.
    const tag = randomUUID().slice(0, 8)
    const acme = await aCompany(`Acme ${tag}`)
    await fileDocument(`upload-${tag}.pdf`, await aBlob(tag), {
      kind: 'record',
      entityId: acme,
    })

    const rows = await shelfTagged(tag)
    expect(rows).toHaveLength(1)
    expect(rows[0].sourcePath).toBeNull()
    expect(rows[0].externalUrl).toBeNull()
    expect(rows[0].externalStatus).toBeNull()
    // Unchanged by this slice, and the reason the Source column can fall
    // back to the origin text at all.
    expect(rows[0].sourceClass).toBe('manual')
    expect(rows[0].sourceCapability).toBeNull()
  })

  it("carries a linked file's path, link and gone status through", async () => {
    const tag = randomUUID().slice(0, 8)
    const acme = await aCompany(`Acme ${tag}`)
    const docId = await fileDocument(`linked-${tag}.pdf`, await aBlob(tag), {
      kind: 'record',
      entityId: acme,
    })

    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    await db
      .update(document)
      .set({
        // Verbatim (§5.3): the shelf prints what the provider called it, so
        // the row reads the way the user would say it out loud.
        sourcePath: 'Data room / Legal',
        externalUrl: 'https://drive.example/file/abc123',
        externalStatus: 'gone',
      })
      .where(eq(document.entityId, docId))

    const rows = await shelfTagged(tag)
    expect(rows).toHaveLength(1)
    expect(rows[0].sourcePath).toBe('Data room / Legal')
    expect(rows[0].externalUrl).toBe('https://drive.example/file/abc123')
    // Deleted on their side, kept on ours (§7, §8) — the row is still here,
    // which is the whole point of copy-in.
    expect(rows[0].externalStatus).toBe('gone')
  })

  it('orders newest first and bounds the snippet at 200 chars', async () => {
    const tag = randomUUID().slice(0, 8)
    const acme = await aCompany(`Acme ${tag}`)
    const older = await fileDocument(
      `older-${tag}.pdf`,
      await aBlob(`a${tag}`),
      { kind: 'record', entityId: acme },
    )
    const newer = await fileDocument(
      `newer-${tag}.pdf`,
      await aBlob(`b${tag}`),
      { kind: 'record', entityId: acme },
    )

    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    await db
      .update(document)
      // Whitespace at both ends and in the middle: the fold collapses runs
      // and trims, so the cap is on what the reader actually gets.
      .set({ extractedText: `  ${'word  '.repeat(200)}` })
      .where(eq(document.entityId, newer))
    await db
      .update(document)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(document.entityId, older))

    const rows = await shelfTagged(tag)
    expect(rows.map((r) => r.id)).toEqual([newer, older])
    const snippet = rows[0].snippet
    expect(snippet).toBeTruthy()
    expect(snippet?.length).toBeLessThanOrEqual(200)
    expect(rows[1].snippet).toBeNull()
  })
})
