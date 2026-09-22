import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_UPLOAD_BYTES } from '@spaces/core/documents'
import { minimalPdf } from '#/test/minimal-pdf'
import type { DocumentIntakeInput } from './intake'

/**
 * The server byte lane (SPA-130) — no browser, no HTTP, no presigned URL:
 * a `Readable` and some metadata go in, a blob, a `document` row and its
 * edges come out.
 *
 * What is actually worth asserting here is the two constraints the shape
 * exists for, because both are invisible in a passing happy path: the digest
 * is measured off the stream rather than taken from anyone, and 250 MB of
 * deck must not become 250 MB of RSS. Hence the temp-directory sweep, the
 * `storage().put` spy, and the RSS bound on a generated 200 MB arrival.
 *
 * The queue is stubbed through `#/test/queue-stub` as in every document
 * fixture file; here it is also how the hand-off to extraction is read, since
 * `enqueue` swallows its own failures and answers `null` either way. The
 * worker is not running, so the extract job's own program is then driven
 * directly against the arrived row — `extractDocument.run` under its real
 * `ExtractionStore` layer, exactly what `runJob` would hand it, with no
 * change to `extract-document`.
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

async function anIntegration(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { integration } = await import('@spaces/db/schema')
  const [row] = await db
    .insert(integration)
    .values({ capabilityId: `gdrive-${tag}`, version: '1.0.0' })
    .returning({ id: integration.id })
  return row.id
}

function shaOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The input every test varies a field or two of. */
async function intake(
  over: Partial<DocumentIntakeInput> & { stream: Readable },
): Promise<{ id: string; deduped: boolean }> {
  const { intakeDocumentProgram } = await import('./intake')
  return Effect.runPromise(
    intakeDocumentProgram({
      filename: 'deck.pdf',
      mime: 'application/pdf',
      declaredSize: null,
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

async function documentRow(id: string) {
  const { db } = await import('@spaces/db')
  const { document } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  return (
    await db
      .select({
        blobSha: document.blobSha,
        sizeBytes: document.sizeBytes,
        sourceClass: document.sourceClass,
        sourceRef: document.sourceRef,
        sourcePath: document.sourcePath,
        externalId: document.externalId,
        extractionStatus: document.extractionStatus,
        extractedText: document.extractedText,
      })
      .from(document)
      .where(eq(document.entityId, id))
  ).at(0)
}

async function taggedInOf(documentId: string): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { link } = await import('@spaces/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const rows = await db
    .select({ to: link.toEntityId })
    .from(link)
    .where(
      and(eq(link.fromEntityId, documentId), eq(link.relation, 'tagged_in')),
    )
  return rows.map((r) => r.to)
}

/** Directories this module left behind under the OS temp dir, if any. */
async function intakeTempDirs(): Promise<Array<string>> {
  const entries = await readdir(tmpdir()).catch(() => [])
  return entries.filter((name) => name.startsWith('spaces-intake-'))
}

describe('intakeDocumentProgram', () => {
  it('arrives a PDF from a Readable: blob, row, tagged_in edge, queued to extract', async () => {
    const tag = randomUUID().slice(0, 8)
    const phrase = `Ohmium electrolyser stack ${tag}`
    const bytes = minimalPdf(phrase)
    const sha = shaOf(bytes)
    const companyId = await aCompany(tag)
    const integrationId = await anIntegration(tag)
    const { storage } = await import('#/lib/storage')

    const { id, deduped } = await intake({
      stream: Readable.from([bytes]),
      filename: `SHA-${tag}.pdf`,
      // §3.1 corrected: the class, never a vendor word, and the ref is the
      // integration's own id. The provider's tree is a label, stored verbatim.
      sourceClass: 'integration',
      sourceRef: integrationId,
      provenance: {
        sourcePath: 'Data room/Legal/SHA.pdf',
        externalId: `drive:${tag}`,
      },
      fileAgainst: [{ kind: 'record', entityId: companyId }],
      actor: { integrationId },
    })

    expect(deduped).toBe(false)
    // The digest intake measured itself, under which the bytes now live.
    expect(await storage().exists(sha)).toBe(true)
    expect(await taggedInOf(id)).toEqual([companyId])
    expect(await documentRow(id)).toMatchObject({
      blobSha: sha,
      sizeBytes: bytes.length,
      sourceClass: 'integration',
      sourceRef: integrationId,
      sourcePath: 'Data room/Legal/SHA.pdf',
      externalId: `drive:${tag}`,
      extractionStatus: 'pending',
    })

    // Birth handed the row to the worker, which is not running here. Driving
    // the extract job itself needs to import `#/worker/**`, and spec §2's
    // seam — `web → core, sdk, never worker`, an eslint zone since SPA-146 —
    // forbids that from `lib/`. So the other half of this arrival, the one
    // that reaches extraction_status 'done' off these exact bytes, is
    // `src/worker/jobs/extract-document.arrival.test.ts`, on the worker's
    // side of the line where the import is legal.
    const { QUEUES } = await import('@spaces/core/queue/names')
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      { name: QUEUES.extractDocument, data: { documentId: id } },
    ])

    await storage().delete(sha)
  })

  it('skips the put when the digest is already stored, and still births', async () => {
    const tag = randomUUID().slice(0, 8)
    const bytes = minimalPdf(`Already here ${tag}`)
    const sha = shaOf(bytes)
    const companyId = await aCompany(tag)
    const { storage } = await import('#/lib/storage')

    // The same bytes, already arrived from another provider.
    await storage().put(sha, bytes, { mime: 'application/pdf' })
    const put = vi.spyOn(storage(), 'put')

    const { id, deduped } = await intake({
      stream: Readable.from([bytes]),
      filename: `dup-${tag}.pdf`,
      fileAgainst: [{ kind: 'record', entityId: companyId }],
    })

    // One blob for two arrivals; the row is born anyway, because §3.4's
    // dedupe is about a target and is birth's rule, not this module's.
    expect(put).not.toHaveBeenCalled()
    expect(deduped).toBe(false)
    expect(await documentRow(id)).toMatchObject({ blobSha: sha })
    expect(await taggedInOf(id)).toEqual([companyId])

    put.mockRestore()
    await storage().delete(sha)
  })

  it('destroys a source past MAX_UPLOAD_BYTES that declared no size, storing nothing', async () => {
    const tag = randomUUID().slice(0, 8)
    const { storage } = await import('#/lib/storage')
    const { documentIntakeMessage } = await import('./intake')
    const put = vi.spyOn(storage(), 'put')

    // 64 MiB at a time until the limit is passed. The same buffer is yielded
    // each time on purpose — nothing here reads the content, and allocating
    // 250 MB of distinct fixture would be the very thing under test.
    const chunk = Buffer.allocUnsafe(64 * 1024 * 1024)
    const chunks = Math.ceil(MAX_UPLOAD_BYTES / chunk.length) + 1
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < chunks; i += 1) yield chunk
      })(),
    )

    const before = await intakeTempDirs()
    await expect(
      intake({
        stream: source,
        filename: `runaway-${tag}.bin`,
        mime: 'application/octet-stream',
        kind: 'other',
        // A Drive Docs export reports no size at all, which is exactly why
        // the meter and not this field is the guard.
        declaredSize: null,
      }),
    ).rejects.toMatchObject({ _tag: 'DocumentTooLarge' })

    // Destroyed mid-transfer: `pipeline` tears down the whole chain, so a
    // runaway provider stops being read from rather than being drained.
    expect(source.destroyed).toBe(true)
    expect(put).not.toHaveBeenCalled()
    // And the half-written temp file went with its directory.
    expect(await intakeTempDirs()).toEqual(before)

    await expect(
      intake({ stream: Readable.from([Buffer.alloc(1)]), declaredSize: 1 }),
    ).resolves.toBeTruthy()

    const failure = await intake({
      stream: Readable.from([chunk]),
      declaredSize: MAX_UPLOAD_BYTES + 1,
    }).then(
      () => null,
      (err: unknown) => err,
    )
    // A declared over-limit size is refused before a byte is read.
    expect(documentIntakeMessage(failure)).toBe('Larger than the 250 MB limit')

    put.mockRestore()
  }, 60_000)

  it('arrives a generated 200 MB fixture with peak RSS growth under 96 MB', async () => {
    const tag = randomUUID().slice(0, 8)
    const { storage } = await import('#/lib/storage')

    // 64 KiB × 3200 = 200 MiB, generated a chunk at a time. Never a Buffer of
    // the whole thing: that is the failure mode this bound exists to catch.
    const CHUNK = 64 * 1024
    const COUNT = 3200
    const hash = createHash('sha256')
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < COUNT; i += 1) {
          const block = Buffer.alloc(CHUNK, i % 251)
          hash.update(block)
          yield block
        }
      })(),
    )

    const baseline = process.memoryUsage().rss
    let peak = baseline
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 20)

    try {
      const { id } = await intake({
        stream: source,
        filename: `big-${tag}.bin`,
        mime: 'application/octet-stream',
        kind: 'other',
      })
      peak = Math.max(peak, process.memoryUsage().rss)

      const sha = hash.digest('hex')
      expect(await documentRow(id)).toMatchObject({
        blobSha: sha,
        sizeBytes: CHUNK * COUNT,
      })
      expect(await storage().exists(sha)).toBe(true)
      await storage().delete(sha)
    } finally {
      clearInterval(sampler)
    }

    // The stated bound: 96 MB of growth for a 200 MB arrival. The temp-file
    // path keeps only what the streams have in flight; buffering the file
    // would put 200 MB of it here, and a Buffer round-trip 400 MB.
    expect(peak - baseline).toBeLessThan(96 * 1024 * 1024)
  }, 60_000)
})

/**
 * Two lanes for bytes, one writer each, and neither module claiming to be the
 * only one — both carry a comment naming the other. Asserted the way
 * `birth.test.ts` asserts its single `insert(document)`: test files and
 * `lib/seeds/` are out of scope, being fixtures rather than paths bytes
 * actually arrive through.
 */
describe('one writer of bytes, per lane', () => {
  const src = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

  function sourcesContaining(needle: string): Array<string> {
    return readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => !f.startsWith('lib/seeds/'))
      .filter((f) => readFileSync(join(src, f), 'utf8').includes(needle))
      .sort()
  }

  /**
   * Two sites, and the second one is named rather than tolerated
   * (docsurf-10b). `intake.ts` is the lane for bytes that still need a
   * document; the clip job's PDF branch has a document already —
   * `clipUrlProgram` wrote the row before the fetch — so it cannot reuse
   * intake without minting a second one and orphaning the first. What it
   * reuses instead is the key: the sha, which is what makes an identical
   * uploaded deck and a clipped one one file on disk.
   *
   * A third entry appearing here is the thing to argue with, not to add.
   */
  it('has exactly two storage().put( outside tests and seeds', () => {
    expect(sourcesContaining('storage().put(')).toEqual([
      'lib/documents/intake.ts',
      'worker/jobs/clip-document.ts',
    ])
  })

  it('has exactly one caller of putContentAddressed, the blob route', () => {
    expect(sourcesContaining('.putContentAddressed(')).toEqual([
      'routes/api/blob/$key.ts',
    ])
  })

  it('has each lane naming the other', () => {
    expect(
      readFileSync(join(src, 'lib/documents/intake.ts'), 'utf8'),
    ).toContain('putContentAddressed')
    expect(readFileSync(join(src, 'lib/storage/local.ts'), 'utf8')).toContain(
      'lib/documents/intake.ts',
    )
    // And the clip's own branch, both ways: why it does not reuse intake,
    // and — in intake — why intake does not serve it.
    expect(
      readFileSync(join(src, 'lib/documents/intake.ts'), 'utf8'),
    ).toContain('clip-document.ts')
    expect(
      readFileSync(join(src, 'worker/jobs/clip-document.ts'), 'utf8'),
    ).toContain('lib/documents/intake.ts')
  })
})
