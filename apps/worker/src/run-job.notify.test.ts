import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { Client } from 'pg'
import type { JobWithMetadata } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  JOB_STATUS_CHANNEL,
  NOTIFY_LIMIT_BYTES,
  decodeJobStatus,
  encodeJobStatus,
} from '@spaces/core/queue/job-status'
import type { JobStatusEvent } from '@spaces/core/queue/job-status'
import type { JobHost, JobOutcome } from './run-job'

/**
 * `job_status`: the ledger announces a plugin queue's row when it opens and
 * when it closes, from the transaction that writes it, and never a core
 * queue's. (D64) Real Postgres on both ends: the LISTEN here is the same
 * statement web's listener runs.
 */

const epoch = new Date(0)

function fakeJob(queue: string, data: object): JobWithMetadata<object> {
  return {
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

const heard: Array<JobStatusEvent> = []
let listener: Client

beforeAll(async () => {
  listener = new Client({ connectionString: process.env.DATABASE_URL })
  await listener.connect()
  listener.on('notification', (message) => {
    if (message.channel !== JOB_STATUS_CHANNEL) return
    const event = decodeJobStatus(message.payload ?? '')
    if (event !== null) heard.push(event)
  })
  await listener.query(`LISTEN ${JOB_STATUS_CHANNEL}`)
})

afterAll(async () => {
  await listener.end()
})

/** Waits until `count` notifications for `queue` have arrived. */
const heardOn = async (queue: string, count: number) => {
  const until = Date.now() + 5000
  for (;;) {
    const mine = heard.filter((e) => e.queue === queue)
    if (mine.length >= count || Date.now() > until) return mine
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const job = (name: string, fail: boolean) =>
  Effect.gen(function* () {
    const { JobPermanent, runJob } = yield* Effect.promise(
      () => import('./run-job'),
    )
    return runJob(
      {
        name,
        schema: z.object({ entityId: z.uuid() }),
        run: () =>
          fail
            ? Effect.fail(new JobPermanent({ reason: 'provider said no' }))
            : Effect.succeed('filled 2 fields'),
        refs: (data) => ({ entityId: data.entityId }),
      },
      { host: silentHost(), layer: Layer.empty },
    )
  })

const seedCompany = async () => {
  const { resolveEntity } = await import('@spaces/core/writes/entities/resolve')
  return (
    await resolveEntity({
      kind: 'company',
      name: `Notify ${randomUUID().slice(0, 6)}`,
      keys: {},
      source: { class: 'manual' },
    })
  ).entityId
}

describe('the job_status announcement', () => {
  it('a plugin job announces running, then its outcome, on its job_run row', async () => {
    const entityId = await seedCompany()
    const queue = `plugin.notify-${randomUUID().slice(0, 6)}.ping`
    const handler = await Effect.runPromise(job(queue, false))
    await handler([fakeJob(queue, { entityId })])

    const events = await heardOn(queue, 2)
    expect(events.map((e) => e.status)).toEqual(['running', 'succeeded'])
    const opened = events.at(0)
    const closed = events.at(1)
    if (opened === undefined) throw new Error('no running event')
    expect(opened).toMatchObject({ entityId, summary: null, error: null })
    expect(closed).toMatchObject({
      jobRunId: opened.jobRunId,
      entityId,
      startedAt: opened.startedAt,
      summary: 'filled 2 fields',
    })

    const { db } = await import('@spaces/db')
    const { jobRun } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const row = (
      await db.select().from(jobRun).where(eq(jobRun.queue, queue))
    ).at(0)
    expect(row?.id).toBe(opened.jobRunId)
    expect(row?.startedAt.toISOString()).toBe(opened.startedAt)
  })

  it('a failed plugin job announces the failure with its tagged error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const entityId = await seedCompany()
    const queue = `plugin.notify-${randomUUID().slice(0, 6)}.ping`
    const handler = await Effect.runPromise(job(queue, true))
    await handler([fakeJob(queue, { entityId })])

    const events = await heardOn(queue, 2)
    expect(events.map((e) => [e.status, e.error])).toEqual([
      ['running', null],
      ['failed', 'permanent: provider said no'],
    ])
    vi.restoreAllMocks()
  })

  it('a core job announces nothing', async () => {
    const entityId = await seedCompany()
    const queue = `test.notify-${randomUUID().slice(0, 6)}`
    const handler = await Effect.runPromise(job(queue, false))
    await handler([fakeJob(queue, { entityId })])
    // A plugin job sent after it is heard; the core job, before it, never is.
    const marker = `plugin.notify-${randomUUID().slice(0, 6)}.ping`
    await (
      await Effect.runPromise(job(marker, false))
    )([fakeJob(marker, { entityId })])
    await heardOn(marker, 2)
    expect(heard.filter((e) => e.queue === queue)).toEqual([])
  })

  it('a payload stays under the NOTIFY limit whatever the texts', () => {
    const long = 'é'.repeat(10_000)
    const payload = encodeJobStatus({
      jobRunId: randomUUID(),
      queue: 'plugin.big.ping',
      integrationId: null,
      entityId: null,
      status: 'failed',
      startedAt: epoch.toISOString(),
      summary: long,
      error: `\u0000${long}`,
    })
    expect(new TextEncoder().encode(payload).length).toBeLessThan(
      NOTIFY_LIMIT_BYTES,
    )
    expect(decodeJobStatus(payload)?.error?.length).toBe(500)
  })
})
