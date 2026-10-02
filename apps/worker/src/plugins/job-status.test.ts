import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { desc, eq } from 'drizzle-orm'
import type { JobWithMetadata } from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { entity, jobRun, workerHeartbeat } from '@spaces/db/schema'
import { WORKER_ROLE } from '@spaces/db/heartbeat'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  WORKER_LOST,
  jobStatusSnapshotProgram,
  recordReadableProgram,
} from '#web/lib/integrations/job-status'
import { runJob } from '../run-job'
import type { JobHost, JobOutcome } from '../run-job'

/**
 * The record page's status snapshot, read from the rows `runJob` actually
 * writes: the latest attempt per plugin queue, a run whose worker is gone
 * settled as failed, and only for a record the viewer could open. (D64)
 */

const epoch = new Date(0)

const fakeJob = (queue: string, data: object): JobWithMetadata<object> => ({
  id: randomUUID(),
  name: queue,
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
})

const host: JobHost = {
  complete: async (_q: string, _id: string, _o: JobOutcome) => undefined,
  fail: async () => undefined,
  failTerminal: async () => undefined,
  send: async () => undefined,
}

const seedCompany = async () =>
  (
    await resolveEntity({
      kind: 'company',
      name: `Snapshot ${randomUUID().slice(0, 6)}`,
      source: { class: 'manual' },
    })
  ).entityId

/** A job on `queue` whose handler finishes when `release` is called. */
const gated = (queue: string) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const handler = runJob(
    {
      name: queue,
      schema: z.object({ entityId: z.uuid() }),
      run: () => Effect.promise(() => gate).pipe(Effect.as('filled 1 field')),
      refs: (data) => ({ entityId: data.entityId }),
    },
    { host, layer: Layer.empty },
  )
  return { handler, release: () => release() }
}

const snapshot = (entityId: string) =>
  Effect.runPromise(jobStatusSnapshotProgram(entityId))

const waitFor = async <T>(read: () => Promise<T>, done: (v: T) => boolean) => {
  const until = Date.now() + 5000
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const setBeat = async (beatAt: Date, bootedAt: Date) => {
  await db.delete(workerHeartbeat).where(eq(workerHeartbeat.role, WORKER_ROLE))
  await db.insert(workerHeartbeat).values({
    role: WORKER_ROLE,
    instance: 'test',
    pid: 1,
    beatAt,
    bootedAt,
  })
}

describe('the job status snapshot', () => {
  it('reads a running row as running while its worker beats, as failed once it is gone, and the close when it lands', async () => {
    const entityId = await seedCompany()
    const queue = `plugin.snap-${randomUUID().slice(0, 6)}.enrich`
    const now = Date.now()
    await setBeat(new Date(now), new Date(now - 60_000))
    const job = gated(queue)
    const done = job.handler([fakeJob(queue, { entityId })])

    const running = await waitFor(
      () => snapshot(entityId),
      (rows) => rows.length === 1,
    )
    expect(running).toMatchObject([
      { queue, entityId, status: 'running', error: null, closedAgoMs: null },
    ])

    // The heartbeat went stale: the worker died mid-run.
    await setBeat(new Date(now - 5 * 60_000), new Date(now - 10 * 60_000))
    expect(await snapshot(entityId)).toMatchObject([
      { queue, status: 'failed', error: WORKER_LOST },
    ])
    // A worker that booted after the run began is not the one running it.
    await setBeat(new Date(), new Date(Date.now() + 1000))
    expect(await snapshot(entityId)).toMatchObject([
      { status: 'failed', error: WORKER_LOST },
    ])
    // No worker has ever beaten.
    await db
      .delete(workerHeartbeat)
      .where(eq(workerHeartbeat.role, WORKER_ROLE))
    expect(await snapshot(entityId)).toMatchObject([
      { status: 'failed', error: WORKER_LOST },
    ])

    job.release()
    await done
    const closed = await waitFor(
      () => snapshot(entityId),
      (rows) => rows.at(0)?.status === 'succeeded',
    )
    expect(closed).toMatchObject([
      { queue, status: 'succeeded', summary: 'filled 1 field', error: null },
    ])
    expect(closed.at(0)?.closedAgoMs).toBeGreaterThanOrEqual(0)
  })

  it('carries the latest attempt per plugin queue and nothing from a core queue', async () => {
    const entityId = await seedCompany()
    const queue = `plugin.snap-${randomUUID().slice(0, 6)}.enrich`
    const first = gated(queue)
    first.release()
    await first.handler([fakeJob(queue, { entityId })])
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = gated(queue)
    second.release()
    await second.handler([fakeJob(queue, { entityId })])
    const coreQueue = `test.snap-${randomUUID().slice(0, 6)}`
    const core = gated(coreQueue)
    core.release()
    await core.handler([fakeJob(coreQueue, { entityId })])

    const rows = await waitFor(
      () => snapshot(entityId),
      (r) => r.every((row) => row.status !== 'running'),
    )
    const runs = await db
      .select({ id: jobRun.id })
      .from(jobRun)
      .where(eq(jobRun.queue, queue))
      .orderBy(desc(jobRun.startedAt))
    expect(runs).toHaveLength(2)
    expect(rows).toHaveLength(1)
    expect(rows.at(0)).toMatchObject({ queue, jobRunId: runs.at(0)?.id })
    expect(await snapshot(randomUUID())).toEqual([])
  })
})

describe('who may watch a record', () => {
  const viewer = { id: randomUUID() }
  const readable = (id: string) =>
    Effect.runPromise(recordReadableProgram(viewer, id))

  it('a live company is readable; a missing or merged-away one is not', async () => {
    const live = await seedCompany()
    const gone = await seedCompany()
    expect(await readable(live)).toBe(true)
    expect(await readable(randomUUID())).toBe(false)
    await db
      .update(entity)
      .set({ mergedIntoId: live })
      .where(eq(entity.id, gone))
    expect(await readable(gone)).toBe(false)
  })
})
