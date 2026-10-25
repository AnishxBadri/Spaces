import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { enqueue as stubSend } from '#web/test/queue-stub'

/**
 * The orphan-blob sweep — the half of blob GC that runs from the upload's
 * side rather than the delete's.
 *
 * The window it closes: `prepareDocumentUpload` hands out a URL, the browser
 * PUTs the bytes, and only `finalizeDocumentUpload` writes the `document`
 * row. A tab closed in between leaves bytes no row will ever name, and
 * delete-side GC never sees them.
 * - Every test drives the real store: the local driver writes plain files
 *   under `<DATA_DIR>/blobs`, so "the bytes are gone" is about a file, not a
 *   call that was made.
 * - The queue is stubbed: birth enqueues extraction and test databases have
 *   no `pgboss` schema.
 * - Here, not in apps/web, because an eslint zone bars it from importing the
 *   worker.
 */
vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

// Birth's extraction enqueue is core's `Enqueue` service; here it records
// into the same stub the mocked `#web/lib/queue` does.
const stubEnqueue = Enqueue.fromSender({ enqueue: stubSend })

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

function shaOf(tag: string): { sha: string; bytes: Buffer } {
  const bytes = Buffer.from(`deck ${tag}\n`, 'utf8')
  return { sha: createHash('sha256').update(bytes).digest('hex'), bytes }
}

/** A prepare, then the PUT the browser would do. No finalize. */
async function prepareAndPut(
  tag: string,
): Promise<{ sha: string; alreadyStored: boolean }> {
  const { Effect } = await import('effect')
  const { prepareBlobUploadProgram } =
    await import('@spaces/core/writes/documents/prepare')
  const { storage } = await import('@spaces/core/writes/storage')
  const { sha, bytes } = shaOf(tag)
  const out = await Effect.runPromise(
    prepareBlobUploadProgram({
      sha,
      sizeBytes: bytes.byteLength,
      preparedBy: await actorId(),
    }),
  )
  // The bytes reach the store however the URL was signed; what matters to the
  // sweep is that they are there and that no document row names them.
  await storage().put(sha, bytes, { mime: 'text/plain' })
  return { sha, alreadyStored: out.alreadyStored }
}

async function pendingRows(sha: string): Promise<Array<{ sha: string }>> {
  const { db } = await import('@spaces/db')
  const { pendingBlob } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  return db
    .select({ sha: pendingBlob.sha })
    .from(pendingBlob)
    .where(eq(pendingBlob.sha, sha))
}

/** Age a pending row by rewriting its clock — a day of waiting, in one line. */
async function agePendingBy(sha: string, ms: number): Promise<void> {
  const { db } = await import('@spaces/db')
  const { pendingBlob } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  await db
    .update(pendingBlob)
    .set({ preparedAt: new Date(Date.now() - ms) })
    .where(eq(pendingBlob.sha, sha))
}

async function sweep(graceMs?: number) {
  const { runSweepOrphanBlobsJob } = await import('./sweep-orphan-blobs')
  return runSweepOrphanBlobsJob(graceMs === undefined ? {} : { graceMs })
}

async function fileIt(sha: string, tag: string, entityId: string) {
  const { Effect } = await import('effect')
  const { birthDocumentProgram } =
    await import('@spaces/core/writes/documents/birth')
  return Effect.runPromise(
    birthDocumentProgram({
      blobSha: sha,
      filename: `deck-${tag}.pdf`,
      mime: 'application/pdf',
      sizeBytes: 11,
      kind: 'other',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: [{ kind: 'record', entityId }],
      actor: { userId: await actorId() },
    }).pipe(Effect.provide(stubEnqueue)),
  )
}

describe('a prepare with no finalize', () => {
  it('leaves the bytes and a pending row, and the grace period decides', async () => {
    const { storage } = await import('@spaces/core/writes/storage')
    const tag = randomUUID().slice(0, 8)
    const { sha } = await prepareAndPut(tag)

    // The abandoned upload, exactly as a closed tab leaves it.
    expect(await storage().exists(sha)).toBe(true)
    expect(await pendingRows(sha)).toEqual([{ sha }])

    // Before the grace period the row is invisible to the sweep — which is
    // the whole safety: a PUT still in flight must never be reclaimed.
    const early = await sweep()
    expect(early.examined).toBe(0)
    expect(early.reclaimed).toBe(0)
    expect(await storage().exists(sha)).toBe(true)
    expect(await pendingRows(sha)).toEqual([{ sha }])

    // A day later, both go.
    await agePendingBy(sha, 25 * 60 * 60 * 1000)
    const late = await sweep()
    expect(late.examined).toBe(1)
    expect(late.reclaimed).toBe(1)
    expect(late.kept).toBe(0)
    expect(await storage().exists(sha)).toBe(false)
    expect(await pendingRows(sha)).toEqual([])
  })

  it('never takes the bytes of a record’s picture', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { storage } = await import('@spaces/core/writes/storage')
    const tag = randomUUID().slice(0, 8)
    const { sha } = await prepareAndPut(tag)
    const co = await aCompany(tag)
    await db.update(entity).set({ pictureSha: sha }).where(eq(entity.id, co))

    await agePendingBy(sha, 25 * 60 * 60 * 1000)
    const result = await sweep()
    expect(result).toMatchObject({ examined: 1, reclaimed: 0, kept: 1 })
    expect(await storage().exists(sha)).toBe(true)

    await db.update(entity).set({ pictureSha: null }).where(eq(entity.id, co))
    await storage().delete(sha)
  })

  it('reclaims nothing on an empty table', async () => {
    const result = await sweep(0)
    expect(result).toMatchObject({ examined: 0, reclaimed: 0, kept: 0 })
  })
})

describe('a prepare followed by a finalize', () => {
  it('leaves no pending row, and the sweep never touches a filed blob', async () => {
    const { storage } = await import('@spaces/core/writes/storage')
    const tag = randomUUID().slice(0, 8)
    const { sha } = await prepareAndPut(tag)
    expect(await pendingRows(sha)).toEqual([{ sha }])

    // Two document rows on one digest — the deck sent to both partners,
    // which is the case a sweep that counted wrong would delete under.
    const first = await fileIt(sha, `${tag}-a`, await aCompany(`a-${tag}`))
    const second = await fileIt(sha, `${tag}-b`, await aCompany(`b-${tag}`))
    expect(first.id).not.toBe(second.id)

    // Birth cleared the intent row; the upload arrived.
    expect(await pendingRows(sha)).toEqual([])

    // Nothing is left for the sweep to find, even with no grace at all.
    const result = await sweep(0)
    expect(result.reclaimed).toBe(0)
    expect(await storage().exists(sha)).toBe(true)

    // And a stale pending row on a filed digest is kept, not reclaimed: the
    // bytes belong to a document row whatever this table says.
    const { db } = await import('@spaces/db')
    const { pendingBlob } = await import('@spaces/db/schema')
    await db.insert(pendingBlob).values({ sha, sizeBytes: 11 })
    await agePendingBy(sha, 25 * 60 * 60 * 1000)
    const second_run = await sweep()
    expect(second_run.examined).toBe(1)
    expect(second_run.kept).toBe(1)
    expect(second_run.reclaimed).toBe(0)
    expect(await storage().exists(sha)).toBe(true)
    // Spent either way — a row the sweep can never act on must not be
    // re-examined every night forever.
    expect(await pendingRows(sha)).toEqual([])
  })

  it('survives one of two rows being deleted, and goes with the last', async () => {
    const { storage } = await import('@spaces/core/writes/storage')
    const { deleteDocumentWithBlobGc } = await import('#web/lib/server/shared')
    const tag = randomUUID().slice(0, 8)
    const { sha } = await prepareAndPut(tag)
    const first = await fileIt(sha, `${tag}-a`, await aCompany(`a-${tag}`))
    const second = await fileIt(sha, `${tag}-b`, await aCompany(`b-${tag}`))

    // The delete path reads the same `blobIsReferenced` the sweep does.
    await deleteDocumentWithBlobGc(first.id)
    expect(await storage().exists(sha)).toBe(true)
    await deleteDocumentWithBlobGc(second.id)
    expect(await storage().exists(sha)).toBe(false)
  })

  it('keeps bytes another document’s revision names, and takes a deleted document’s own history', async () => {
    const { db } = await import('@spaces/db')
    const { documentRevision } = await import('@spaces/db/schema')
    const { storage } = await import('@spaces/core/writes/storage')
    const { deleteDocumentWithBlobGc } = await import('#web/lib/server/shared')
    const tag = randomUUID().slice(0, 8)
    const shared = await prepareAndPut(`s-${tag}`)
    const own = await prepareAndPut(`o-${tag}`)
    const current = await prepareAndPut(`c-${tag}`)
    const holder = await fileIt(
      shared.sha,
      `h-${tag}`,
      await aCompany(`h-${tag}`),
    )
    // A followed document that advanced past both: its history names them.
    const followed = await fileIt(
      current.sha,
      `f-${tag}`,
      await aCompany(`f-${tag}`),
    )
    await db.insert(documentRevision).values([
      { documentId: followed.id, blobSha: shared.sha, externalRevisionId: '1' },
      { documentId: followed.id, blobSha: own.sha, externalRevisionId: '2' },
    ])
    // Its bytes were once the row's current ones: the intent was spent then.
    const { pendingBlob } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    await db.delete(pendingBlob).where(eq(pendingBlob.sha, own.sha))

    // The holder's bytes are still another document's prior revision.
    await deleteDocumentWithBlobGc(holder.id)
    expect(await storage().exists(shared.sha)).toBe(true)

    // The followed document's history goes with it, and so do its bytes.
    await deleteDocumentWithBlobGc(followed.id)
    for (const { sha } of [shared, own, current])
      expect(await storage().exists(sha), sha).toBe(false)
  })

  it('takes the blob’s cached extractions with the bytes, and leaves a filed blob’s alone', async () => {
    // Answers keyed by the sha go through the same reclaim the bytes do, so
    // neither direction of GC can strand one.
    const { db } = await import('@spaces/db')
    const { extractionCache } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { storage } = await import('@spaces/core/writes/storage')
    const cached = (sha: string) =>
      db
        .select({ sha: extractionCache.blobSha })
        .from(extractionCache)
        .where(eq(extractionCache.blobSha, sha))
    const answer = (sha: string) =>
      db
        .insert(extractionCache)
        .values({ blobSha: sha, schemaKey: 'k', modelId: 'm', patch: {} })

    const tag = randomUUID().slice(0, 8)
    const orphan = await prepareAndPut(`o-${tag}`)
    const filed = await prepareAndPut(`f-${tag}`)
    await fileIt(filed.sha, `f-${tag}`, await aCompany(`f-${tag}`))
    await answer(orphan.sha)
    await answer(filed.sha)
    // Birth clears its own pending row; put it back so the sweep examines
    // the filed blob too and must decide to keep it.
    await prepareAndPut(`f-${tag}`)
    await agePendingBy(orphan.sha, 25 * 60 * 60 * 1000)
    await agePendingBy(filed.sha, 25 * 60 * 60 * 1000)

    const result = await sweep()
    expect(result).toMatchObject({ reclaimed: 1 })
    expect(await storage().exists(orphan.sha)).toBe(false)
    expect(await cached(orphan.sha)).toEqual([])
    expect(await storage().exists(filed.sha)).toBe(true)
    expect(await cached(filed.sha)).toEqual([{ sha: filed.sha }])
  })
})

describe('the alreadyStored short circuit', () => {
  it('writes no pending row when the store already holds the blob', async () => {
    const { db } = await import('@spaces/db')
    const { pendingBlob } = await import('@spaces/db/schema')
    const { storage } = await import('@spaces/core/writes/storage')
    const tag = randomUUID().slice(0, 8)
    const { sha, bytes } = shaOf(tag)

    // A deck the workspace already has — filed, extracted, done.
    await storage().put(sha, bytes, { mime: 'text/plain' })
    await fileIt(sha, tag, await aCompany(tag))
    expect(await pendingRows(sha)).toEqual([])

    // Re-uploading it: the prepare short-circuits and must leave the table
    // alone. A row here would put a known deck's bytes on the sweep's list.
    const { Effect } = await import('effect')
    const { prepareBlobUploadProgram } =
      await import('@spaces/core/writes/documents/prepare')
    const out = await Effect.runPromise(
      prepareBlobUploadProgram({
        sha,
        sizeBytes: bytes.byteLength,
        preparedBy: await actorId(),
      }),
    )
    expect(out).toEqual({
      uploadUrl: null,
      uploadHeaders: {},
      alreadyStored: true,
    })
    expect(await db.select({ sha: pendingBlob.sha }).from(pendingBlob)).toEqual(
      [],
    )

    // Belt and braces: even a zero grace period finds nothing to do.
    const result = await sweep(0)
    expect(result).toMatchObject({ examined: 0, reclaimed: 0 })
    expect(await storage().exists(sha)).toBe(true)
  })

  it('re-preparing an abandoned upload resets its clock', async () => {
    const tag = randomUUID().slice(0, 8)
    const { sha } = await prepareAndPut(tag)
    await agePendingBy(sha, 25 * 60 * 60 * 1000)

    // The operator tries again. A second prepare is an upload starting over,
    // so it must not inherit the abandoned attempt's remaining grace.
    const { storage } = await import('@spaces/core/writes/storage')
    await storage().delete(sha)
    await prepareAndPut(tag)

    const result = await sweep()
    expect(result.examined).toBe(0)
    expect(await storage().exists(sha)).toBe(true)
  })
})

/**
 * The hoist, mechanically. "Is any document row on this sha" is one question
 * with two askers — the delete path and the sweep — and a second copy of the
 * count is how the two directions drift apart about what "referenced" means.
 * `grep` for the query outside its own module must be empty.
 */
describe('one reference check', () => {
  it('has no second copy of the count query outside blob-refs.ts', () => {
    // Both source trees: the sweep is apps/worker's, the delete path and the
    // query's home are apps/web's.
    const root = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../..',
    )
    const askers = ['apps/web/src', 'apps/worker/src']
      .flatMap((tree) =>
        readdirSync(join(root, tree), { recursive: true, encoding: 'utf8' })
          .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
          .map((f) => join(tree, f)),
      )
      .filter((f) => {
        const text = readFileSync(join(root, f), 'utf8')
        // A count over `document` **narrowed by** its blob digest: the
        // `eq(...)` is what makes it this query rather than a coincidence. A
        // module that reads the column while counting something else (the
        // shelf does) is not a second asker.
        return text.includes('count()') && text.includes('eq(document.blobSha')
      })
      .sort()
    expect(askers).toEqual(['apps/web/src/lib/documents/blob-refs.ts'])
  })
})
