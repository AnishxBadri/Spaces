import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

// The test databases carry no `pgboss` schema, and the birth of a document
// enqueues extraction — see `#/test/queue-stub`.
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

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
  const { Effect } = await import('effect')
  const { birthDocumentProgram } = await import('./birth')
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
      fileAgainst: [{ kind: 'space', entityId: spaceId }],
      actor: { userId: await actorId() },
    }),
  )
  return id
}

async function sourcesOf(spaceId: string) {
  const { Effect } = await import('effect')
  const { spaceSourcesProgram } = await import('./space-sources')
  return Effect.runPromise(spaceSourcesProgram(spaceId))
}

async function inheritedOf(spaceId: string) {
  const { Effect } = await import('effect')
  const { spaceInheritedSourcesProgram } = await import('./space-sources')
  return Effect.runPromise(spaceInheritedSourcesProgram(spaceId))
}

/** A live company, optionally tagged into a space. */
async function aCompany(name: string, spaceId?: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity, entitySpace } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  if (spaceId) {
    await db
      .insert(entitySpace)
      .values({ entityId: ent.id, spaceId, createdBy: await actorId() })
  }
  return ent.id
}

/** `link(tagged_in)` — the edge a record filing writes. */
async function fileAgainstRecord(
  entityId: string,
  filename: string,
  sha: string,
): Promise<string> {
  const { Effect } = await import('effect')
  const { birthDocumentProgram } = await import('./birth')
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
      fileAgainst: [{ kind: 'record', entityId }],
      actor: { userId: await actorId() },
    }),
  )
  return id
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
    const { Effect } = await import('effect')
    const { birthDocumentProgram } = await import('./birth')
    const tag = randomUUID().slice(0, 8)

    const spaceId = await aSpace(tag)
    const [ent] = await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `Ohmium ${tag}` })
      .returning({ id: entity.id })
    await db.insert(company).values({ entityId: ent.id })

    await Effect.runPromise(
      birthDocumentProgram({
        blobSha: await aBlob(tag),
        filename: `deck-${tag}.pdf`,
        mime: 'application/pdf',
        sizeBytes: 2048,
        kind: 'deck',
        sourceClass: 'manual',
        sourceRef: null,
        provenance: {},
        fileAgainst: [{ kind: 'record', entityId: ent.id }],
        actor: { userId: await actorId() },
      }),
    )

    // `link(tagged_in)` is the record's edge and never a space's: a lane
    // keyed on it would have shown this row here.
    expect(await sourcesOf(spaceId)).toEqual([])
  })
})

/**
 * The inherited lane (SPA-67) — documents reached *through* the companies
 * tagged into the space. What is worth pinning is the seam between the two
 * lanes: a document that is both filed here and tagged onto a company here
 * belongs to the direct list and must not be counted twice, and the merge
 * filter has to hold on both ends of the join, because there are now two
 * `entity` rows in one statement.
 */
describe('spaceInheritedSourcesProgram', () => {
  it('reads documents on a company tagged into the space, newest first', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const companyId = await aCompany(`Ohmium ${tag}`, spaceId)

    expect(await inheritedOf(spaceId)).toEqual([])

    const older = await fileAgainstRecord(
      companyId,
      `older-${tag}.pdf`,
      await aBlob(`a-${tag}`),
    )
    const newer = await fileAgainstRecord(
      companyId,
      `newer-${tag}.pdf`,
      await aBlob(`b-${tag}`),
    )

    const rows = await inheritedOf(spaceId)
    expect(rows.map((r) => r.id)).toEqual([newer, older])

    const row = rows[0]
    expect(row.companyId).toBe(companyId)
    expect(row.companyName).toBe(`Ohmium ${tag}`)
    // The rest is the row shape the direct lane returns — the section
    // renders both lanes through one component.
    expect(row.filename).toBe(`newer-${tag}.pdf`)
    expect(row.kind).toBe('deck')
    expect(row.sizeBytes).toBe(2048)
    expect(row.mime).toBe('application/pdf')
    expect(row.extractionStatus).toBe('pending')
    expect(row.uploadedByName).toBeTruthy()
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.sinceMs).toBeGreaterThanOrEqual(0)

    // And the direct lane is untouched by any of it: nothing was filed into
    // the space itself, so the headline count is still zero.
    expect(await sourcesOf(spaceId)).toEqual([])
  })

  it('leaves a doubly-filed document to the direct lane', async () => {
    const { db } = await import('@spaces/db')
    const { link } = await import('@spaces/db/schema')
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const companyId = await aCompany(`Electric Hydrogen ${tag}`, spaceId)

    // Filed into the space *and* tagged onto a company in it.
    const both = await fileIntoSpace(
      spaceId,
      `both-${tag}.pdf`,
      await aBlob(`both-${tag}`),
    )
    await db.insert(link).values({
      fromEntityId: both,
      toEntityId: companyId,
      relation: 'tagged_in',
      source: 'manual',
      createdBy: await actorId(),
    })

    const onlyCompany = await fileAgainstRecord(
      companyId,
      `company-${tag}.pdf`,
      await aBlob(`c-${tag}`),
    )

    expect((await sourcesOf(spaceId)).map((r) => r.id)).toEqual([both])
    expect((await inheritedOf(spaceId)).map((r) => r.id)).toEqual([onlyCompany])
  })

  it('gives one row per company when a deck hangs off two companies here', async () => {
    const { db } = await import('@spaces/db')
    const { link } = await import('@spaces/db/schema')
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const first = await aCompany(`Alpha ${tag}`, spaceId)
    const second = await aCompany(`Beta ${tag}`, spaceId)

    const doc = await fileAgainstRecord(
      first,
      `shared-${tag}.pdf`,
      await aBlob(tag),
    )
    await db.insert(link).values({
      fromEntityId: doc,
      toEntityId: second,
      relation: 'tagged_in',
      source: 'manual',
      createdBy: await actorId(),
    })

    // Two edges, two rows — the company column is what tells them apart,
    // and `link_edge_unique` is what stops a third.
    const rows = await inheritedOf(spaceId)
    expect(rows.map((r) => r.companyName)).toEqual([
      `Alpha ${tag}`,
      `Beta ${tag}`,
    ])
    expect(rows.every((r) => r.id === doc)).toBe(true)
  })

  it('drops a merged-away company and a merged-away document', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)

    const kept = await aCompany(`Kept ${tag}`, spaceId)
    const merged = await aCompany(`Merged ${tag}`, spaceId)
    const keptDoc = await fileAgainstRecord(
      kept,
      `kept-${tag}.pdf`,
      await aBlob(`k-${tag}`),
    )
    const deadDoc = await fileAgainstRecord(
      kept,
      `dead-${tag}.pdf`,
      await aBlob(`d-${tag}`),
    )
    await fileAgainstRecord(
      merged,
      `hidden-${tag}.pdf`,
      await aBlob(`h-${tag}`),
    )

    await db
      .update(entity)
      .set({ mergedIntoId: kept })
      .where(eq(entity.id, merged))
    await db
      .update(entity)
      .set({ mergedIntoId: keptDoc })
      .where(eq(entity.id, deadDoc))

    expect((await inheritedOf(spaceId)).map((r) => r.id)).toEqual([keptDoc])
  })

  it('is empty for a space with no companies, and for companies with no documents', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    expect(await inheritedOf(spaceId)).toEqual([])

    await aCompany(`Empty ${tag}`, spaceId)
    expect(await inheritedOf(spaceId)).toEqual([])
  })

  it('does not reach a company that is not tagged into this space', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const elsewhere = await aCompany(`Elsewhere ${tag}`)

    await fileAgainstRecord(elsewhere, `deck-${tag}.pdf`, await aBlob(tag))

    expect(await inheritedOf(spaceId)).toEqual([])
  })
})
