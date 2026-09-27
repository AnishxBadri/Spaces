import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { handleApiRequest } from '#/lib/rpc/api'
import { CAPTURE_SCHEMA_VERSION } from '#/lib/rpc/versions'
import { storage } from '#/lib/storage'
import { createApiTokenProgram } from '#/lib/tokens/store'
import { JobContext } from '../run-job'
import { ExtractionStore, extractDocument } from './extract-document'

/**
 * SPA-111's last acceptance criterion, on the worker's side of the seam for
 * the reason `extract-document.arrival.test.ts` gives (nothing under `lib/`
 * may import `#/worker/**`): a page captured through `POST /api/v1/capture`
 * reaches `extraction_status 'done'` through the existing extract job, with
 * no change to it. The job runs under its real `ExtractionStore` layer and
 * the `JobContext` `runJob` would hand it; the queue is the stub, whose
 * record is the enqueue the job would have been woken by.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

beforeEach(async () => {
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
})

describe('a captured page, through the existing extract job', () => {
  it('reaches extraction_status done with the page text extracted', async () => {
    const tag = randomUUID().slice(0, 8)
    const text = `Ada Example\nFounder, Orbital Composites\nCarbon-fibre tanks ${tag}`
    const { token } = await Effect.runPromise(
      createApiTokenProgram({
        userId: FIXTURE_ACTOR.id,
        name: 'spa111-worker',
        scopes: ['capture:write'],
      }),
    )

    const response = await handleApiRequest(
      new Request('http://spaces.test/api/v1/capture', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
          url: `https://www.linkedin.com/in/ada-example-${tag}/`,
          title: `Ada Example ${tag} | LinkedIn`,
          capturedAt: '2026-09-28T09:30:00Z',
          text,
        }),
      }),
    )
    expect(response.status).toBe(200)
    const { documentId } = z
      .object({ documentId: z.string() })
      .parse(await response.json())

    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      { name: QUEUES.extractDocument, data: { documentId } },
    ])

    // Exactly what `runJob` would run, minus the ledger it writes around it.
    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          extractDocument.run({ documentId }),
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

    const row = (
      await db
        .select({
          blobSha: document.blobSha,
          extractionStatus: document.extractionStatus,
          extractedText: document.extractedText,
        })
        .from(document)
        .where(eq(document.entityId, documentId))
    ).at(0)
    expect(row?.extractionStatus).toBe('done')
    expect(row?.extractedText).toContain(`Carbon-fibre tanks ${tag}`)

    if (row?.blobSha) await storage().delete(row.blobSha)
  })
})
