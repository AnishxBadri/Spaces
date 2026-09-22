import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

// Birth enqueues extraction and the test databases carry no `pgboss` schema.
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Unfiled is defined by **edges** — SPA-124, `docs/spec-storage-sources.md`
 * §3.2. Six states in one fixture, because the bug this file exists to
 * prevent is a definition that drifts toward `source_class` or `blob_sha`:
 * the moment "unfiled" means "uploaded by hand" or "has no bytes", a plugin
 * that filed nothing stops being visible and the arrival is lost, which is
 * the whole point of the inbox.
 *
 * The two `NOT EXISTS` halves are what the record-only and space-only rows
 * pin. An anti-join over both edge tables would let a document carrying one
 * edge kind survive the other's null test — it would read as unfiled while
 * sitting on a company's Files tab.
 *
 * Dynamic imports for the reason the rest of the DB-coupled suite uses them:
 * `@spaces/db` builds its pool from `DATABASE_URL` at import time and
 * `vitest.setup.ts` rewrites it per file. The programs are called directly —
 * the server fns need a request no test has.
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

/** An installed connector, so a document can carry a real `source_ref`. */
async function anIntegration(capabilityId: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { integration } = await import('@spaces/db/schema')
  const [row] = await db
    .insert(integration)
    .values({ capabilityId, version: '1.0.0', enabled: true })
    .returning({ id: integration.id })
  return row.id
}

type Birth = {
  filename: string
  blobSha: string | null
  sourceClass: 'manual' | 'integration'
  sourceRef: string | null
  externalUrl?: string
  fileAgainst: Array<{ kind: 'record' | 'space'; entityId: string }>
}

async function birth(input: Birth): Promise<string> {
  const { Effect } = await import('effect')
  const { birthDocumentProgram } = await import('#/lib/documents/birth')
  const { id } = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: input.blobSha,
      filename: input.filename,
      mime: 'application/pdf',
      sizeBytes: input.blobSha === null ? null : 2048,
      kind: 'deck',
      sourceClass: input.sourceClass,
      sourceRef: input.sourceRef,
      provenance:
        input.externalUrl === undefined
          ? {}
          : { externalUrl: input.externalUrl },
      fileAgainst: input.fileAgainst,
      // An integration files as itself — null in every user column.
      actor:
        input.sourceClass === 'integration'
          ? { integrationId: input.sourceRef ?? '' }
          : { userId: await actorId() },
    }),
  )
  return id
}

/**
 * The shelf is the whole workspace, and truncation is per test *file*
 * (CLAUDE.md → Isolation), so every case tags its fixtures and reads back
 * only its own rather than asserting on the bare list.
 */
async function shelf(filed: 'all' | 'unfiled', tag: string) {
  const { Effect } = await import('effect')
  const { listDocumentsProgram } = await import('./shelf')
  const rows = await Effect.runPromise(listDocumentsProgram({ filed }))
  return rows.filter((r) => r.filename.includes(tag))
}

async function unfiledCount(): Promise<number> {
  const { Effect } = await import('effect')
  const { countUnfiledProgram } = await import('./shelf')
  return Effect.runPromise(countUnfiledProgram())
}

describe('the unfiled predicate', () => {
  it('returns exactly the edgeless rows, whatever lane they came down', async () => {
    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(`Unfiled Co ${tag}`)
    const spaceId = await aSpace(`Unfiled Space ${tag}`)
    const integrationId = await anIntegration('gmail')

    // 1. No edges at all — a global upload nobody has filed yet.
    const bare = await birth({
      filename: `bare-${tag}.pdf`,
      blobSha: await aBlob(`bare-${tag}`),
      sourceClass: 'manual',
      sourceRef: null,
      fileAgainst: [],
    })
    // 2. A record edge only.
    const onRecord = await birth({
      filename: `record-${tag}.pdf`,
      blobSha: await aBlob(`record-${tag}`),
      sourceClass: 'manual',
      sourceRef: null,
      fileAgainst: [{ kind: 'record', entityId: companyId }],
    })
    // 3. An `entity_space` edge only — filed in a space, on no record. The
    //    half a single anti-join would get wrong.
    const inSpace = await birth({
      filename: `space-${tag}.pdf`,
      blobSha: await aBlob(`space-${tag}`),
      sourceClass: 'manual',
      sourceRef: null,
      fileAgainst: [{ kind: 'space', entityId: spaceId }],
    })
    // 4. Both kinds at once.
    const both = await birth({
      filename: `both-${tag}.pdf`,
      blobSha: await aBlob(`both-${tag}`),
      sourceClass: 'manual',
      sourceRef: null,
      fileAgainst: [
        { kind: 'record', entityId: companyId },
        { kind: 'space', entityId: spaceId },
      ],
    })
    // 5. A blobless url-origin row with no edges — a clip keeps a snapshot
    //    and no bytes. `blob_sha IS NULL` is not what makes it unfiled.
    const clip = await birth({
      filename: `clip-${tag}.pdf`,
      blobSha: null,
      sourceClass: 'manual',
      sourceRef: null,
      externalUrl: `https://example.test/${tag}`,
      fileAgainst: [],
    })
    // 6. An integration-filed row with no edges — the plugin found no match.
    //    `source_class = 'integration'` is not what makes it filed.
    const fromPlugin = await birth({
      filename: `integration-${tag}.pdf`,
      blobSha: await aBlob(`integration-${tag}`),
      sourceClass: 'integration',
      sourceRef: integrationId,
      fileAgainst: [],
    })

    expect((await shelf('all', tag)).map((r) => r.id).sort()).toEqual(
      [bare, onRecord, inSpace, both, clip, fromPlugin].sort(),
    )

    // Exactly the three edgeless rows, and not one of the three filed ones.
    expect((await shelf('unfiled', tag)).map((r) => r.id).sort()).toEqual(
      [bare, clip, fromPlugin].sort(),
    )
  })

  it('stops counting a document the moment it gains either edge kind', async () => {
    const tag = randomUUID().slice(0, 8)
    const before = await unfiledCount()

    const toRecord = await birth({
      filename: `later-record-${tag}.pdf`,
      blobSha: await aBlob(`later-record-${tag}`),
      sourceClass: 'manual',
      sourceRef: null,
      fileAgainst: [],
    })
    const toSpace = await birth({
      filename: `later-space-${tag}.pdf`,
      blobSha: await aBlob(`later-space-${tag}`),
      sourceClass: 'manual',
      sourceRef: null,
      fileAgainst: [],
    })
    expect(await unfiledCount()).toBe(before + 2)

    const { db } = await import('@spaces/db')
    const { entitySpace, link } = await import('@spaces/db/schema')
    await db.insert(link).values({
      fromEntityId: toRecord,
      toEntityId: await aCompany(`Later Co ${tag}`),
      relation: 'tagged_in',
      createdBy: await actorId(),
    })
    expect(await unfiledCount()).toBe(before + 1)

    await db.insert(entitySpace).values({
      entityId: toSpace,
      spaceId: await aSpace(`Later Space ${tag}`),
      createdBy: await actorId(),
    })
    expect(await unfiledCount()).toBe(before)
    expect(await shelf('unfiled', tag)).toEqual([])
  })

  it('does not count a merged-away document, the way the shelf does not list it', async () => {
    const tag = randomUUID().slice(0, 8)
    const survivor = await birth({
      filename: `survivor-${tag}.pdf`,
      blobSha: await aBlob(`survivor-${tag}`),
      sourceClass: 'manual',
      sourceRef: null,
      fileAgainst: [],
    })
    const tombstone = await birth({
      filename: `tombstone-${tag}.pdf`,
      blobSha: await aBlob(`tombstone-${tag}`),
      sourceClass: 'manual',
      sourceRef: null,
      fileAgainst: [],
    })

    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const before = await unfiledCount()
    await db
      .update(entity)
      .set({ mergedIntoId: survivor })
      .where(eq(entity.id, tombstone))

    expect(await unfiledCount()).toBe(before - 1)
    expect((await shelf('unfiled', tag)).map((r) => r.id)).toEqual([survivor])
  })
})
