import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QUEUES } from '@spaces/core/queue/names'
import { minimalPdf } from '#/test/minimal-pdf'
import { JobContext } from '../run-job'
import { ExtractionStore, extractDocument } from './extract-document'

/**
 * The second half of SPA-130's arrival test, and it lives here rather than
 * beside `lib/documents/intake.test.ts` for one mechanical reason: spec §2's
 * seam — `web → core, sdk. Never plugins/*, never worker` — is an eslint zone
 * (`import/no-restricted-paths`, SPA-146), so nothing under `lib/` may import
 * `#/worker/**`, a test included. The worker is allowed to be the worker, so
 * the join runs on this side of the line.
 *
 * What it asserts is the acceptance criterion `intake.test.ts` can only take
 * to the enqueue: a fixture PDF that arrived through the **server byte lane**
 * — a `Readable`, no browser, no HTTP — reaches `extraction_status 'done'`
 * through the existing `extract-document` job, with no change to it. The job
 * runs under its real `ExtractionStore` layer and the `JobContext` `runJob`
 * would hand it, which is everything `runJob` provides bar the ledger.
 *
 * The queue is stubbed as in every document fixture file: birth enqueues, and
 * there is no pg-boss schema on a test database.
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

describe('a server-lane arrival, through the existing extract job', () => {
  it('reaches extraction_status done off bytes that never touched a browser', async () => {
    const tag = randomUUID().slice(0, 8)
    const phrase = `Ohmium electrolyser stack ${tag}`
    const bytes = minimalPdf(phrase)
    const companyId = await aCompany(tag)

    const { intakeDocumentProgram } = await import('#/lib/documents/intake')
    const { id } = await Effect.runPromise(
      intakeDocumentProgram({
        stream: Readable.from([bytes]),
        filename: `SHA-${tag}.pdf`,
        mime: 'application/pdf',
        declaredSize: null,
        kind: 'legal',
        sourceClass: 'manual',
        sourceRef: null,
        provenance: { sourcePath: 'Data room/Legal/SHA.pdf' },
        fileAgainst: [{ kind: 'record', entityId: companyId }],
        actor: { userId: await actorId() },
      }),
    )

    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      { name: QUEUES.extractDocument, data: { documentId: id } },
    ])

    // Exactly what `runJob` would run, minus the ledger it writes around it.
    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          extractDocument.run({ documentId: id }),
          JobContext,
          JobContext.of({
            queue: QUEUES.extractDocument,
            jobId: `test-${tag}`,
            attempt: 1,
            isFinalAttempt: true,
          }),
        ),
        ExtractionStore.layer,
      ),
    )

    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const row = (
      await db
        .select({
          blobSha: document.blobSha,
          sourcePath: document.sourcePath,
          extractionStatus: document.extractionStatus,
          extractedText: document.extractedText,
        })
        .from(document)
        .where(eq(document.entityId, id))
    ).at(0)

    expect(row?.extractionStatus).toBe('done')
    expect(row?.extractedText).toContain(phrase)
    // The provider's own tree, stored verbatim — a label, never a key (§5.3).
    expect(row?.sourcePath).toBe('Data room/Legal/SHA.pdf')

    const { storage } = await import('#/lib/storage')
    if (row?.blobSha) await storage().delete(row.blobSha)
  })
})
