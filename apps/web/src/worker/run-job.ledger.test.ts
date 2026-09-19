import { createHash, randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { JobWithMetadata } from 'pg-boss'
import type { JobHost, JobOutcome } from './run-job'

/**
 * The `job_run` rows themselves, against a real database. The wrapper's own
 * tests (`run-job.test.ts`) drive it through a fake JobHost with the ledger
 * stubbed out, which is right for the settlement logic and useless for the
 * ledger: the claim here is that Postgres actually holds one row per attempt
 * with a duration on each, and only Postgres can say so.
 *
 * Everything is imported dynamically: `@spaces/db` builds its pool from
 * `process.env.DATABASE_URL` at import time, and `vitest.setup.ts` rewrites
 * that to this worker's database before the file runs.
 */

const epoch = new Date(0)

function fakeJob(
  queue: string,
  data: object,
  retry: { count: number; limit: number },
): JobWithMetadata<object> {
  return {
    id: randomUUID(),
    name: queue,
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: retry.limit,
    retryCount: retry.count,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: epoch,
    startedOn: epoch,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 604800,
    createdOn: epoch,
    completedOn: null,
    keepUntil: epoch,
    policy: 'standard',
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: '',
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  }
}

function silentHost(): JobHost {
  const noop = async (_q: string, _id: string, _o: JobOutcome) => undefined
  return {
    complete: noop,
    fail: noop,
    failTerminal: noop,
    send: async () => undefined,
  }
}

describe('runJob — the job_run ledger', () => {
  it('writes one row per pg-boss attempt, each with a duration', async () => {
    const { JobRetryable, runJob } = await import('./run-job')
    const { db } = await import('@spaces/db')
    const { jobRun } = await import('@spaces/db/schema')
    const { asc, eq } = await import('drizzle-orm')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const queue = `test.ledger-${randomUUID().slice(0, 8)}`
    const handler = runJob(
      {
        name: queue,
        schema: z.object({ n: z.number() }),
        run: () =>
          Effect.fail(new JobRetryable({ reason: 'blob not there yet' })),
      },
      { host: silentHost(), layer: Layer.empty },
    )

    // Attempt 1, then the retry pg-boss hands back out with retryCount = 1.
    await handler([fakeJob(queue, { n: 1 }, { count: 0, limit: 2 })])
    await handler([fakeJob(queue, { n: 1 }, { count: 1, limit: 2 })])

    const rows = await db
      .select()
      .from(jobRun)
      .where(eq(jobRun.queue, queue))
      .orderBy(asc(jobRun.attempt))

    expect(rows.map((r) => r.attempt)).toEqual([1, 2])
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed'])
    for (const row of rows) {
      expect(row.durationMs).not.toBeNull()
      expect(row.finishedAt).not.toBeNull()
      // A sweep has no entity and a core job has no integration: both refs
      // are nullable because both are genuinely absent, not as a hedge.
      expect(row.entityId).toBeNull()
      expect(row.integrationId).toBeNull()
      expect(row.error).toBe('retryable: blob not there yet')
    }
    vi.restoreAllMocks()
  })

  it('carries no tokens column — ai_usage is the token ledger', async () => {
    const { db } = await import('@spaces/db')
    const columns = await db.$client.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'job_run'",
    )
    const names = columns.rows.map((r) => String(r.column_name)).sort()
    // spec-plugin-sdk §11 sketches `tokens?` on this row; it is overridden in
    // packages/db/src/schema/jobs.ts because a retried attempt would
    // double-count. Asserting the absence keeps the override from being
    // quietly undone by someone reading the spec instead of the schema.
    expect(names).not.toContain('tokens')
    expect(names).toEqual([
      'attempt',
      'duration_ms',
      'entity_id',
      'error',
      'finished_at',
      'id',
      'integration_id',
      'queue',
      'started_at',
      'status',
    ])
  })

  it('pins the status enum to running | succeeded | failed | skipped', async () => {
    const { db } = await import('@spaces/db')
    const values = await db.$client.query(
      "select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'job_run_status' order by e.enumsortorder",
    )
    expect(values.rows.map((r) => String(r.enumlabel))).toEqual([
      'running',
      'succeeded',
      'failed',
      'skipped',
    ])
  })
})

describe('extractDocument — the row the wrapper writes for it', () => {
  it('records the extract queue, the document entity, and a status matching the row', async () => {
    const run = await extraction({ corrupt: false })
    expect(run.jobRun.queue).toBe(run.queueName)
    expect(run.jobRun.entityId).toBe(run.documentId)
    expect(run.jobRun.attempt).toBe(1)
    expect(run.jobRun.durationMs).not.toBeNull()
    // done ↔ succeeded: the two sides of the same attempt.
    expect(run.document.extractionStatus).toBe('done')
    expect(run.jobRun.status).toBe('succeeded')
    expect(run.jobRun.error).toBeNull()
  })

  it('keeps the typed tag on job_run and the operator text on the document', async () => {
    const run = await extraction({ corrupt: true })
    expect(run.document.extractionStatus).toBe('failed')
    expect(run.jobRun.status).toBe('failed')

    // Two columns, two readers. job_run.error leads with runJob's outcome tag
    // — a classification every queue shares, on a ledger that will be pruned.
    // document.extraction_error is the sentence the Files tab renders, and it
    // is the current state of the document, not of one attempt.
    expect(run.jobRun.error?.startsWith('permanent: ')).toBe(true)
    expect(run.document.extractionError).toContain(
      'Blob integrity check failed',
    )
    expect(run.document.extractionError?.startsWith('permanent: ')).toBe(false)
  })
})

/**
 * Drives the real `extractDocument` through `runJob` against the real
 * database, with only the blob store faked — the bytes are the one thing a
 * test cannot reasonably stand up, and they are not what is being asserted.
 * `corrupt` points the row's sha somewhere else, which is the integrity
 * backstop's failure and lands as a JobPermanent.
 */
async function extraction(options: { corrupt: boolean }) {
  const { runJob } = await import('./run-job')
  const { ExtractionStore, extractDocument } =
    await import('./jobs/extract-document')
  const { db } = await import('@spaces/db')
  const { document, entity, jobRun } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')

  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  const bytes = new TextEncoder().encode('Series A term sheet. 20% discount.\n')
  const sha = createHash('sha256').update(bytes).digest('hex')

  const [ent] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: `terms-${randomUUID()}.txt` })
    .returning({ id: entity.id })
  const documentId = ent.id
  await db.insert(document).values({
    entityId: documentId,
    blobSha: options.corrupt ? createHash('sha256').digest('hex') : sha,
    filename: 'terms.txt',
    mime: 'text/plain',
    sizeBytes: bytes.length,
  })

  // The real store for every database write, so `extraction_status` and
  // `extraction_error` are written by the code that ships; only `bytes` is
  // replaced.
  const real = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* ExtractionStore
      }),
      ExtractionStore.layer,
    ),
  )
  const layer = Layer.succeed(
    ExtractionStore,
    ExtractionStore.of({ ...real, bytes: () => Effect.succeed(bytes) }),
  )

  await runJob(extractDocument, { host: silentHost(), layer })([
    fakeJob(extractDocument.name, { documentId }, { count: 0, limit: 2 }),
  ])

  const [runRow] = await db
    .select()
    .from(jobRun)
    .where(eq(jobRun.entityId, documentId))
  const [docRow] = await db
    .select()
    .from(document)
    .where(eq(document.entityId, documentId))

  vi.restoreAllMocks()
  return {
    documentId,
    queueName: extractDocument.name,
    jobRun: runRow,
    document: docRow,
  }
}
