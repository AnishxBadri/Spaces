import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipUrlInput } from './clip'

/**
 * The URL clip's web half (SPA-117) — §3.1's one arrival that keeps no bytes.
 *
 * What this file is really asserting is a sequence: the row exists **before**
 * anything is fetched. Nothing here stubs `fetch`, and nothing here needs to,
 * because `clipUrlProgram` returning without one is the contract — a server
 * function that held a request open while somebody else's web server thought
 * about it would be the bug. The fetching is `worker/jobs/clip-document.ts`,
 * and its own test drives it.
 *
 * The queue is stubbed through `#/test/queue-stub`, as in every document
 * fixture file, and here it is also the assertion: a blobless row must
 * enqueue `document.clip` and must **not** enqueue `document.extract`, which
 * would spend a worker attempt writing 'unsupported' on a row that has no
 * bytes by design. `enqueue` swallows its own failures and answers `null`
 * either way, so the stub is the only seam that can see the decision.
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

async function clip(
  over: Partial<ClipUrlInput> & { url?: string },
): Promise<{ id: string; deduped: boolean }> {
  const { Effect } = await import('effect')
  const { clipUrlProgram } = await import('./clip')
  return Effect.runPromise(
    clipUrlProgram({
      url: 'https://example.com/hydrogen-electrolysers',
      fileAgainst: [],
      actor: { userId: await actorId() },
      ...over,
    }),
  )
}

async function documentRow(id: string) {
  const { db } = await import('@spaces/db')
  const { document, entity } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const row = (
    await db
      .select({
        blobSha: document.blobSha,
        filename: document.filename,
        url: document.url,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        kind: document.kind,
        sourceClass: document.sourceClass,
        sourceRef: document.sourceRef,
        externalUrl: document.externalUrl,
        extractionStatus: document.extractionStatus,
        canonicalName: entity.canonicalName,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(eq(document.entityId, id))
  ).at(0)
  expect(row).toBeTruthy()
  return row
}

describe('clipUrlProgram', () => {
  it('births a blobless row carrying the URL, pending, named by the URL', async () => {
    const url = 'https://example.com/an-article'
    const { id, deduped } = await clip({ url })
    expect(deduped).toBe(false)

    const row = await documentRow(id)
    // No bytes: this is why birth's blobSha is nullable at all.
    expect(row?.blobSha).toBeNull()
    expect(row?.sizeBytes).toBeNull()
    expect(row?.mime).toBeNull()
    // The clip's own address, on the column that marks it a clip.
    expect(row?.url).toBe(url)
    // `external_url` is docsurf-11's "Open in source" for a *provider's* copy
    // and must stay null: the clip's URL already has a column.
    expect(row?.externalUrl).toBeNull()
    // The class is `manual` and never `url` — D1/SPA-137 collapsed the old
    // `document_origin` enum, and a person pasting a link into a surface we
    // ship is the plainest manual write there is (§11 delta 2).
    expect(row?.sourceClass).toBe('manual')
    expect(row?.sourceRef).toBeNull()
    expect(row?.kind).toBe('article')
    // Named by the URL until the worker has a title.
    expect(row?.filename).toBe(url)
    expect(row?.canonicalName).toBe(url)
    expect(row?.extractionStatus).toBe('pending')
  })

  it('enqueues document.clip and never document.extract', async () => {
    const { QUEUES } = await import('@spaces/core/queue/names')
    const { id } = await clip({})
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      { name: QUEUES.clipDocument, data: { documentId: id } },
    ])
  })

  it('files against a record through link(tagged_in)', async () => {
    const { db } = await import('@spaces/db')
    const { link } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const companyId = await aCompany('clip-record')
    const { id } = await clip({
      fileAgainst: [{ kind: 'record', entityId: companyId }],
    })
    const edges = await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(and(eq(link.fromEntityId, id), eq(link.relation, 'tagged_in')))
    expect(edges.map((e) => e.to)).toEqual([companyId])
  })

  it('files into a space through entity_space, and into N places at once', async () => {
    const { db } = await import('@spaces/db')
    const { entitySpace, link } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const companyId = await aCompany('clip-both')
    const spaceId = await aSpace('clip-both')
    const { id } = await clip({
      fileAgainst: [
        { kind: 'record', entityId: companyId },
        { kind: 'space', entityId: spaceId },
      ],
    })
    const spaces = await db
      .select({ space: entitySpace.spaceId })
      .from(entitySpace)
      .where(eq(entitySpace.entityId, id))
    const records = await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(eq(link.fromEntityId, id))
    expect(spaces.map((s) => s.space)).toEqual([spaceId])
    expect(records.map((r) => r.to)).toEqual([companyId])
  })

  it('refuses a private or non-http URL with the guard’s own sentence', async () => {
    const { ClipUrlRejected, clipUrlMessage } = await import('./clip')
    for (const url of [
      'http://localhost:3000/admin',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
    ]) {
      const failure = await clip({ url }).catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(ClipUrlRejected)
      // The sentence, not an empty tagged error — the `ledgerVoidMessage`
      // rule: `Schema.TaggedError` carries no `message`.
      expect(clipUrlMessage(failure).length).toBeGreaterThan(10)
    }
    // Nothing was born and nothing was enqueued.
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([])
  })

  it('refuses a target that will not take a filing, before the row exists', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const spaceId = await aSpace('clip-wrong-mechanism')
    const url = 'https://example.com/never-born'
    // A space is filed *into*, never *against* — birth's own refusal, and it
    // has to come back through the clip's message function too.
    const failure = await clip({
      url,
      fileAgainst: [{ kind: 'record', entityId: spaceId }],
    }).catch((err: unknown) => err)
    const { clipUrlMessage } = await import('./clip')
    expect(clipUrlMessage(failure)).toContain('filed into')
    // Truncation is per file, not per test, so the assertion is about this
    // URL and not about the table being empty.
    expect(
      await db
        .select({ url: document.url })
        .from(document)
        .where(eq(document.url, url)),
    ).toEqual([])
  })
})
