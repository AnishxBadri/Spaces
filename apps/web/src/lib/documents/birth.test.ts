import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentBirthInput } from './birth'

/**
 * The birth of a document (SPA-113) — §3.1's one server path, and the four
 * widenings it took so entry points 2–9 need no second writer: N targets,
 * a nullable blob, a nullable actor, and one provenance bag.
 *
 * The last test in the file is the enforcer for all of it: exactly one
 * `insert(document)` outside tests and seeds. A second writer is how the
 * dedupe rule, the activity line and the enqueue drift apart, and the grep
 * catches it before a reviewer has to.
 *
 * The queue is stubbed through `#/test/queue-stub`, as in every document
 * fixture file. Here it is also the assertion: whether extraction is enqueued
 * is part of this slice — enqueueing a blobless row spends a worker attempt
 * to write 'unsupported', and never enqueueing a blob-bearing one leaves it
 * 'pending' forever — and there is no other seam to read it through, since
 * `enqueue` swallows its own failures and answers `null` either way.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

beforeEach(async () => {
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
})

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

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

async function aSpace(tag: string): Promise<string> {
  const { createSpaceRow } = await import('#/lib/server/shared')
  return createSpaceRow(`Hydrogen ${tag}`, null, await actorId())
}

/** A digest, which is all birth ever sees of a file. */
function aSha(tag: string): string {
  return createHash('sha256').update(`deck ${tag}\n`, 'utf8').digest('hex')
}

/** The input every test varies one field of. */
async function birth(
  over: Partial<DocumentBirthInput> & { filename?: string },
): Promise<{ id: string; deduped: boolean }> {
  const { Effect } = await import('effect')
  const { birthDocumentProgram } = await import('./birth')
  return Effect.runPromise(
    birthDocumentProgram({
      blobSha: aSha('default'),
      filename: 'deck.pdf',
      mime: 'application/pdf',
      sizeBytes: 1024,
      kind: 'deck',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: [],
      actor: { userId: await actorId() },
      ...over,
    }),
  )
}

async function edgesOf(
  documentId: string,
): Promise<{ links: Array<string>; spaces: Array<string> }> {
  const { db } = await import('@spaces/db')
  const { entitySpace, link } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const links = await db
    .select({ to: link.toEntityId })
    .from(link)
    .where(eq(link.fromEntityId, documentId))
  const spaces = await db
    .select({ space: entitySpace.spaceId })
    .from(entitySpace)
    .where(eq(entitySpace.entityId, documentId))
  return { links: links.map((r) => r.to), spaces: spaces.map((r) => r.space) }
}

async function activityFor(documentId: string) {
  const { db } = await import('@spaces/db')
  const { activity } = await import('@spaces/db/schema/activity')
  const { and, eq } = await import('drizzle-orm')
  return db
    .select({
      verb: activity.verb,
      subject: activity.subjectEntityId,
      actorId: activity.actorId,
    })
    .from(activity)
    .where(
      and(
        eq(activity.objectEntityId, documentId),
        eq(activity.verb, 'document.filed'),
      ),
    )
}

async function documentsWithSha(sha: string): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { document } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const rows = await db
    .select({ id: document.entityId })
    .from(document)
    .where(eq(document.blobSha, sha))
  return rows.map((r) => r.id)
}

describe('birthDocumentProgram', () => {
  it('files one row against two targets, as two edges (§3.4)', async () => {
    const tag = randomUUID().slice(0, 8)
    const sha = aSha(tag)
    const companyId = await aCompany(tag)
    const spaceId = await aSpace(tag)

    const { id, deduped } = await birth({
      blobSha: sha,
      filename: `deck-${tag}.pdf`,
      fileAgainst: [
        { kind: 'record', entityId: companyId },
        { kind: 'space', entityId: spaceId },
      ],
    })

    expect(deduped).toBe(false)
    // One row. The deck lives on the company *and* in the space without
    // being copied — the whole point of the rule.
    expect(await documentsWithSha(sha)).toEqual([id])
    expect(await edgesOf(id)).toEqual({
      links: [companyId],
      spaces: [spaceId],
    })
  })

  it('re-filing against one of those targets dedupes, with no second row', async () => {
    const tag = randomUUID().slice(0, 8)
    const sha = aSha(tag)
    const companyId = await aCompany(tag)
    const spaceId = await aSpace(tag)

    const first = await birth({
      blobSha: sha,
      filename: `deck-${tag}.pdf`,
      fileAgainst: [
        { kind: 'record', entityId: companyId },
        { kind: 'space', entityId: spaceId },
      ],
    })
    const again = await birth({
      blobSha: sha,
      filename: `deck-${tag}.pdf`,
      fileAgainst: [{ kind: 'space', entityId: spaceId }],
    })

    expect(again).toEqual({ id: first.id, deduped: true })
    expect(await documentsWithSha(sha)).toEqual([first.id])
  })

  it('gives a deduped row the requested edges it was missing', async () => {
    const tag = randomUUID().slice(0, 8)
    const sha = aSha(tag)
    const companyId = await aCompany(tag)
    const spaceId = await aSpace(tag)

    const first = await birth({
      blobSha: sha,
      filename: `deck-${tag}.pdf`,
      fileAgainst: [{ kind: 'record', entityId: companyId }],
    })
    // Only the record matched; the space is new to this row and must be
    // filed anyway, rather than dropped with the dedupe.
    const again = await birth({
      blobSha: sha,
      filename: `deck-${tag}.pdf`,
      fileAgainst: [
        { kind: 'record', entityId: companyId },
        { kind: 'space', entityId: spaceId },
      ],
    })

    expect(again).toEqual({ id: first.id, deduped: true })
    expect(await edgesOf(first.id)).toEqual({
      links: [companyId],
      spaces: [spaceId],
    })
  })

  it('never dedupes an empty target array — two drops, two unfiled rows', async () => {
    const tag = randomUUID().slice(0, 8)
    const sha = aSha(tag)

    const first = await birth({ blobSha: sha, filename: `deck-${tag}.pdf` })
    const second = await birth({ blobSha: sha, filename: `deck-${tag}.pdf` })

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(false)
    expect(second.id).not.toBe(first.id)
    expect((await documentsWithSha(sha)).sort()).toEqual(
      [first.id, second.id].sort(),
    )
    expect(await edgesOf(first.id)).toEqual({ links: [], spaces: [] })

    // §3.4's rule is about a target, and there is none — so the activity row
    // takes the document's own id as its subject, the column being NOT NULL.
    expect(await activityFor(first.id)).toEqual([
      { verb: 'document.filed', subject: first.id, actorId: await actorId() },
    ])
  })

  it('puts the single target on the activity row, and the document for N', async () => {
    const tag = randomUUID().slice(0, 8)
    const companyId = await aCompany(tag)
    const spaceId = await aSpace(tag)

    const one = await birth({
      blobSha: aSha(`one-${tag}`),
      filename: `one-${tag}.pdf`,
      fileAgainst: [{ kind: 'record', entityId: companyId }],
    })
    expect((await activityFor(one.id)).map((r) => r.subject)).toEqual([
      companyId,
    ])

    const many = await birth({
      blobSha: aSha(`many-${tag}`),
      filename: `many-${tag}.pdf`,
      fileAgainst: [
        { kind: 'record', entityId: companyId },
        { kind: 'space', entityId: spaceId },
      ],
    })
    expect((await activityFor(many.id)).map((r) => r.subject)).toEqual([
      many.id,
    ])
  })

  it('writes a null actor_id when an integration files, and names it by ref', async () => {
    const { db } = await import('@spaces/db')
    const { document, entity, entitySpace, integration } =
      await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const tag = randomUUID().slice(0, 8)

    const [row] = await db
      .insert(integration)
      .values({ capabilityId: `gdrive-${tag}`, version: '1.0.0' })
      .returning({ id: integration.id })
    const spaceId = await aSpace(tag)

    const { id } = await birth({
      blobSha: aSha(tag),
      filename: `drive-${tag}.pdf`,
      sourceClass: 'integration',
      sourceRef: row.id,
      provenance: {
        sourcePath: 'Data room / Legal',
        externalId: `drive:${tag}`,
        externalUrl: `https://drive.example/${tag}`,
      },
      fileAgainst: [{ kind: 'space', entityId: spaceId }],
      actor: { integrationId: row.id },
    })

    // Every user column is null: `activity.actor_id`, `entity.created_by`,
    // `document.uploaded_by` and `entity_space.created_by` all reference
    // `user.id`, and an integration is not a user. `source_ref` is what
    // names it, which is the column the biconditional check constrains.
    expect(await activityFor(id)).toEqual([
      { verb: 'document.filed', subject: spaceId, actorId: null },
    ])
    const doc = (
      await db
        .select({
          uploadedBy: document.uploadedBy,
          sourceClass: document.sourceClass,
          sourceRef: document.sourceRef,
          sourcePath: document.sourcePath,
          externalId: document.externalId,
          externalUrl: document.externalUrl,
        })
        .from(document)
        .where(eq(document.entityId, id))
    ).at(0)
    expect(doc).toEqual({
      uploadedBy: null,
      sourceClass: 'integration',
      sourceRef: row.id,
      sourcePath: 'Data room / Legal',
      externalId: `drive:${tag}`,
      externalUrl: `https://drive.example/${tag}`,
    })
    const ent = (
      await db
        .select({ createdBy: entity.createdBy, sourceRef: entity.sourceRef })
        .from(entity)
        .where(eq(entity.id, id))
    ).at(0)
    expect(ent).toEqual({ createdBy: null, sourceRef: row.id })
    const edge = (
      await db
        .select({ createdBy: entitySpace.createdBy })
        .from(entitySpace)
        .where(eq(entitySpace.entityId, id))
    ).at(0)
    expect(edge?.createdBy).toBe(null)
  })

  it('enqueues extraction for a stored blob, and skips it when there is none', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { QUEUES } = await import('@spaces/core/queue/names')
    const tag = randomUUID().slice(0, 8)

    const stored = await birth({
      blobSha: aSha(tag),
      filename: `deck-${tag}.pdf`,
    })
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      { name: QUEUES.extractDocument, data: { documentId: stored.id } },
    ])

    // `extract-document` refuses a null blob_sha as 'unsupported', so an
    // enqueue here would spend a worker attempt to write a failure. The row
    // stays 'pending' and the caller that clipped the bytes sets its own.
    enqueued.length = 0
    const { id } = await birth({
      blobSha: null,
      filename: `clip-${tag}.html`,
      mime: 'text/html',
      sizeBytes: null,
      kind: 'other',
    })
    expect(enqueued).toEqual([])

    const row = (
      await db
        .select({
          blobSha: document.blobSha,
          extractionStatus: document.extractionStatus,
          extractionError: document.extractionError,
        })
        .from(document)
        .where(eq(document.entityId, id))
    ).at(0)
    expect(row).toEqual({
      blobSha: null,
      extractionStatus: 'pending',
      extractionError: null,
    })
  })

  it('does not enqueue a second extraction for a deduped row', async () => {
    const tag = randomUUID().slice(0, 8)
    const sha = aSha(tag)
    const companyId = await aCompany(tag)
    const target = { kind: 'record', entityId: companyId } as const

    const { enqueued } = await import('#/test/queue-stub')
    await birth({
      blobSha: sha,
      filename: `deck-${tag}.pdf`,
      fileAgainst: [target],
    })
    enqueued.length = 0
    // The bytes were already extracted, or already queued to be: a
    // double-click must not double the worker's work.
    await birth({
      blobSha: sha,
      filename: `deck-${tag}.pdf`,
      fileAgainst: [target],
    })
    expect(enqueued).toEqual([])
  })

  it('refuses a merged-away target by name', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { documentBirthMessage } = await import('./birth')
    const tag = randomUUID().slice(0, 8)

    const kept = await aCompany(`kept-${tag}`)
    const gone = await aCompany(`gone-${tag}`)
    await db
      .update(entity)
      .set({ mergedIntoId: kept })
      .where(eq(entity.id, gone))

    try {
      await birth({
        blobSha: aSha(tag),
        fileAgainst: [{ kind: 'record', entityId: gone }],
      })
      throw new Error('The filing was accepted; it should have been refused')
    } catch (err) {
      expect(documentBirthMessage(err)).toMatch(
        /was merged into another record/,
      )
    }
    // Nothing was written: the check runs before the dedupe read and before
    // the transaction.
    expect(await documentsWithSha(aSha(tag))).toEqual([])
  })
})

/**
 * §3.1's promise, mechanically. `grep -rn 'insert(document)' src` outside
 * tests and seeds must be **one** line, and it must be birth's.
 */
describe('one writer', () => {
  it('has exactly one insert(document) outside tests and seeds', () => {
    const src = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
    const writers = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => !f.startsWith('lib/seeds/'))
      .filter((f) =>
        readFileSync(join(src, f), 'utf8').includes('insert(document)'),
      )
      .sort()
    expect(writers).toEqual(['lib/documents/birth.ts'])
  })
})
