import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { JobWithMetadata } from 'pg-boss'
import { db } from '@spaces/db'
import { importBatch, importRow, jobRun, objectDef } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { beginImportMappingProgram } from '#web/lib/import/mapping'
import { planImportProgram } from '#web/lib/import/plan'
import { loadImportReceiptProgram } from '#web/lib/import/commit'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { runJob } from '../run-job'
import type { JobHost, JobOutcome } from '../run-job'
import { importCommit } from './import-commit'

/**
 * SPA-169: `import.commit` through `runJob`, so the `job_run` row it leaves
 * is the real one — the ledger the batch page reads its last run from. The
 * commit's own behaviour is `#/lib/import/commit.test.ts`.
 */

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

const ME = FIXTURE_ACTOR.id

async function plannedCompanies(rows: Array<Array<string>>): Promise<string> {
  const companies = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, 'companies'))
  ).at(0)
  if (!companies) throw new Error('companies missing')
  const batch = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'd'.repeat(64),
        filename: 'companies.csv',
        sizeBytes: 100,
        sheet: 'companies',
        sheets: ['companies'],
        headerRow: 0,
        header: ['Name', 'Domain'],
        mode: 'records',
        targetObjectId: companies.id,
        rowCount: rows.length,
        createdBy: ME,
      })
      .returning({ id: importBatch.id })
  ).at(0)
  if (!batch) throw new Error('batch insert returned no row')
  await db
    .insert(importRow)
    .values(
      rows.map((cells, i) => ({ batchId: batch.id, rowNum: i + 1, cells })),
    )
  await Effect.runPromise(beginImportMappingProgram(batch.id))
  await Effect.runPromise(planImportProgram(batch.id))
  return batch.id
}

function recordingHost(): JobHost & { calls: Array<string> } {
  const calls: Array<string> = []
  const record =
    (name: string) => async (_q: string, _id: string, _o: JobOutcome) => {
      calls.push(name)
    }
  return {
    calls,
    complete: record('complete'),
    fail: record('fail'),
    failTerminal: record('failTerminal'),
    send: async () => undefined,
  }
}

describe('import.commit through runJob', () => {
  it('leaves a job_run row whose summary names the batch, and the receipt reads it', async () => {
    const batchId = await plannedCompanies([['Ledgered', 'ledgered.com']])
    const host = recordingHost()
    await runJob(importCommit, { host, layer: Layer.empty })([
      fakeJob({ batchId, userId: ME, onlyFailed: false }),
    ])
    expect(host.calls).toEqual(['complete'])
    const run = (
      await db
        .select()
        .from(jobRun)
        .where(eq(jobRun.queue, QUEUES.importCommit))
    ).at(0)
    expect(run?.status).toBe('succeeded')
    expect(run?.durationMs).not.toBeNull()
    expect(run?.summary).toBe(
      `batch ${batchId} · 1 written · 0 attached · 0 failed · 0 unchanged`,
    )

    const receipt = await Effect.runPromise(
      loadImportReceiptProgram({ batchId, filter: 'all' }),
    )
    expect(receipt?.lastRun?.line).toBe(
      '1 written · 0 attached · 0 failed · 0 unchanged',
    )
    expect(receipt?.rows[0].outcome.kind).toBe('created')
    expect(receipt?.rows[0].record?.href).toMatch(/^\/companies\//)

    // Again: the run writes nothing, and its line says so.
    await runJob(importCommit, { host, layer: Layer.empty })([
      fakeJob({ batchId, userId: ME, onlyFailed: false }),
    ])
    const again = await Effect.runPromise(
      loadImportReceiptProgram({ batchId, filter: 'all' }),
    )
    expect(again?.lastRun?.line).toBe(
      '0 written · 0 attached · 0 failed · 1 unchanged',
    )
  })

  it('fails a batch that cannot commit permanently, naming the batch', async () => {
    const batchId = await plannedCompanies([
      ['Fork A', 'fork.co'],
      ['Fork B', 'fork.co'],
    ])
    const host = recordingHost()
    await runJob(importCommit, { host, layer: Layer.empty })([
      fakeJob({ batchId, userId: ME, onlyFailed: false }),
    ])
    expect(host.calls).toEqual(['failTerminal'])
    const run = (
      await db
        .select()
        .from(jobRun)
        .where(
          and(
            eq(jobRun.queue, QUEUES.importCommit),
            eq(jobRun.status, 'failed'),
          ),
        )
    ).at(0)
    expect(run?.status).toBe('failed')
    expect(run?.error).toBe(
      `permanent: batch ${batchId} · 2 rows collide — decide them before committing`,
    )
  })
})

const epoch = new Date(0)

function fakeJob(data: object): JobWithMetadata<object> {
  return {
    id: randomUUID(),
    name: QUEUES.importCommit,
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryLimit: 0,
    retryCount: 0,
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
    policy: 'exclusive',
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
