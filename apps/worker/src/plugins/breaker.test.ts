import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { and, eq, isNotNull } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import type { JobWithMetadata } from 'pg-boss'
import { z } from 'zod'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { db } from '@spaces/db'
import { integration, jobRun } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  BREAKER_REASON,
  JobPermanent,
  JobRateLimited,
  pgBossHost,
  runJob,
} from '../run-job'
import type { JobHost, JobOutcome } from '../run-job'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { breakerGroup } from './queues'

/**
 * The plugin breaker against a real pg-boss on this worker's test database:
 * the throws fixture's `boom` fails every run, five failures in a row trip
 * its integration to `disabled`, its queues stop, and everything else in the
 * process keeps working.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)

let boss: PgBoss

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined) throw new Error('DATABASE_URL is unset')
  boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    schedule: false,
    supervise: false,
  })
  boss.on('error', (error: Error) => console.error('[pg-boss]', error))
  await boss.start()
  for (const queue of await boss.getQueues())
    if (queue.name.startsWith('plugin.') || queue.name.startsWith('test.'))
      await boss.deleteQueue(queue.name)
})

afterAll(async () => {
  await boss.stop({ graceful: false })
})

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-breaker-')),
    'plugins',
  )
  mkdirSync(root, { recursive: true })
  return root
}

const install = (root: string, fixture: string) => {
  const dir = path.join(root, fixture, 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(path.join(fixtures, fixture, 'dist', file), path.join(dir, file))
}

/** A one-job bundle whose `ping` dies after `delayMs`, run `concurrency` at a time. */
const writeFailing = (
  root: string,
  id: string,
  options: { readonly delayMs: number; readonly concurrency: number },
) => {
  const dir = path.join(root, id, 'current')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifestVersion: 1,
      id,
      version: '0.1.0',
      sdk: '^1.0',
      name: id,
      description: 'A breaker test bundle whose one job always fails.',
      settings: {},
      jobs: {
        ping: {
          trigger: 'action',
          uses: ['Log'],
          concurrency: options.concurrency,
        },
      },
    }),
  )
  writeFileSync(
    path.join(dir, 'bundle.mjs'),
    [
      "import { Effect } from 'effect'",
      "import { z } from 'zod'",
      'export default {',
      `  manifest: { id: '${id}', settings: z.object({}) },`,
      `  jobs: { ping: () => Effect.sleep(${String(options.delayMs)}).pipe(Effect.andThen(Effect.die(new Error('${id}: ping failed')))) },`,
      '}',
    ].join('\n'),
  )
}

const row = async (capabilityId: string) => {
  const inserted = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true })
      .returning()
  ).at(0)
  if (!inserted) throw new Error('no integration row')
  return inserted
}

const rowOf = async (id: string) => {
  const found = (
    await db.select().from(integration).where(eq(integration.id, id))
  ).at(0)
  if (!found) throw new Error(`no integration ${id}`)
  return found
}

/** What the reset button will do; by SQL here. */
const reset = (id: string) =>
  db
    .update(integration)
    .set({ status: 'enabled', errorCount: 0, lastError: null })
    .where(eq(integration.id, id))

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []

const newHost = () => {
  const host = makePluginHost({
    enqueue: noEnqueue,
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    sink: () => undefined,
  })
  hosts.push(host)
  return host
}

const load = async (root: string) =>
  Effect.runPromise(reconcilePlugins({ pluginsRoot: root }))

const boot = async (root: string) => {
  const host = newHost()
  const { loaded, verdicts: loader } = await load(root)
  const verdicts = await Effect.runPromise(host.wire(loaded))
  return { host, loaded, loader, verdicts }
}

const waitFor = async <T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> => {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const stateOf = async (queue: string, id: string) =>
  (await boss.getJobById(queue, id))?.state ?? null

const FINAL = new Set(['completed', 'failed', 'cancelled'])

const settled = (queue: string, id: string) =>
  waitFor(
    () => stateOf(queue, id),
    (state) => state !== null && FINAL.has(state),
  )

const send = async (queue: string, data: object) => {
  const id = await boss.send(queue, data)
  if (id === null) throw new Error(`${queue} refused the job`)
  return id
}

/** Sends one job and waits for pg-boss to settle it. */
/**
 * pg-boss settles the job before `runJob` closes its `job_run` row, and the
 * breaker's charge commits with that close — so wait for the row too.
 */
const run = async (queue: string, data: object) => {
  const state = await settled(queue, await send(queue, data))
  await waitFor(
    () =>
      db
        .select({ id: jobRun.id })
        .from(jobRun)
        .where(and(eq(jobRun.queue, queue), eq(jobRun.status, 'running'))),
    (rows) => rows.length === 0,
  )
  return state
}

/** A job sent now that nobody works stays `created`. */
const unworked = async (queue: string, data: object) => {
  const id = await send(queue, data)
  // Three polling intervals: nobody is working the queue.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  return stateOf(queue, id)
}

const runsOf = (integrationId: string) =>
  db.select().from(jobRun).where(eq(jobRun.integrationId, integrationId))

const seedCompany = async () =>
  (
    await resolveEntity({
      kind: 'company',
      name: `Northwind ${randomUUID().slice(0, 8)}`,
      keys: { domain: `northwind-${randomUUID().slice(0, 8)}.example` },
      source: { class: 'manual' },
    })
  ).entityId

/** A core queue on the same pg-boss, worked through `runJob`, as extraction is. */
const coreQueueWorks = async () => {
  const queue = `test.core-${randomUUID().slice(0, 8)}`
  await boss.createQueue(queue)
  await boss.work(
    queue,
    { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 0.5 },
    runJob(
      {
        name: queue,
        schema: z.object({ n: z.number() }),
        run: ({ n }) => Effect.succeed(`ran ${String(n)}`),
      },
      { host: pgBossHost(boss), layer: Layer.empty },
    ),
  )
  const state = await run(queue, { n: 1 })
  await boss.offWork(queue)
  const ran = (
    await db.select().from(jobRun).where(eq(jobRun.queue, queue))
  ).map((r) => [r.status, r.summary, r.integrationId])
  return { state, ran }
}

/** Sequential jobs on a 0.5s poll: seconds per test, not milliseconds. */
const SLOW = 60_000

const BOOM = 'plugin.throws.boom'
const FINE = 'plugin.throws.fine'

beforeAll(() => {
  // runJob reports every defect; the breaker is what is under test.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterAll(() => {
  vi.restoreAllMocks()
})

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  // A job a test left queued must not run in the next one.
  for (const queue of await boss.getQueues())
    if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

describe('a failed plugin job is charged to its integration', () => {
  it(
    'increments error_count and stamps last_error with the typed tag, with the row that closes the run',
    async () => {
      const companyId = await seedCompany()
      const root = newPluginsRoot()
      install(root, 'throws')
      const throws = await row('throws')
      await boot(root)

      expect(await run(BOOM, { entityId: companyId })).toBe('cancelled')
      const after = await rowOf(throws.id)
      expect(after.errorCount).toBe(1)
      expect(after.lastError).toMatch(/^defect: throws: boom on /)
      expect(after.status).toBe('enabled')
      const runs = await runsOf(throws.id)
      expect(runs.map((r) => [r.queue, r.status])).toEqual([[BOOM, 'failed']])
      expect(runs.at(0)?.error).toBe(after.lastError)

      // A success charges nothing.
      expect(await run(FINE, { entityId: companyId })).toBe('completed')
      expect((await rowOf(throws.id)).errorCount).toBe(1)
    },
    SLOW,
  )
})

describe('five failures in a row trip the breaker', () => {
  it(
    'disables the integration, leaves it enabled, stops its queues, and the worker keeps working',
    async () => {
      const companyId = await seedCompany()
      const root = newPluginsRoot()
      install(root, 'throws')
      install(root, 'echo')
      const throws = await row('throws')
      const echo = await row('echo')
      const { host } = await boot(root)

      for (let i = 0; i < 4; i++)
        expect(await run(BOOM, { entityId: companyId })).toBe('cancelled')
      expect((await rowOf(throws.id)).status).toBe('enabled')

      expect(await run(BOOM, { entityId: companyId })).toBe('cancelled')
      const tripped = await rowOf(throws.id)
      expect(tripped).toMatchObject({
        enabled: true,
        status: 'disabled',
        lastError: BREAKER_REASON,
        errorCount: 5,
      })
      expect(BREAKER_REASON).toBe('5 failures in an hour')
      const runs = await runsOf(throws.id)
      expect(runs).toHaveLength(5)
      expect(runs.every((r) => r.status === 'failed')).toBe(true)

      // Released from a detached fiber once the tripping job has returned.
      expect(
        await waitFor(
          () => host.granted(throws.id, 'boom'),
          (granted) => granted === null,
        ),
      ).toBeNull()
      expect(await unworked(BOOM, { entityId: companyId })).toBe('created')
      expect(await runsOf(throws.id)).toHaveLength(5)

      // The rest of the process: another plugin, and a core queue.
      expect(await run('plugin.echo.echo', { entityId: companyId })).toBe(
        'completed',
      )
      expect((await runsOf(echo.id)).map((r) => r.status)).toEqual([
        'succeeded',
      ])
      expect(await coreQueueWorks()).toEqual({
        state: 'completed',
        ran: [['succeeded', 'ran 1', null]],
      })
      expect((await rowOf(echo.id)).status).toBe('enabled')
    },
    SLOW,
  )

  it(
    'four failures, a success, then one failure does not trip it',
    async () => {
      const companyId = await seedCompany()
      const root = newPluginsRoot()
      install(root, 'throws')
      const throws = await row('throws')
      const { host } = await boot(root)

      for (let i = 0; i < 4; i++) await run(BOOM, { entityId: companyId })
      expect(await run(FINE, { entityId: companyId })).toBe('completed')
      await run(BOOM, { entityId: companyId })

      expect(await rowOf(throws.id)).toMatchObject({
        status: 'enabled',
        errorCount: 5,
      })
      expect(host.granted(throws.id, 'boom')).not.toBeNull()
      // Four more after the success make five in a row.
      for (let i = 0; i < 4; i++) await run(BOOM, { entityId: companyId })
      expect((await rowOf(throws.id)).status).toBe('disabled')
    },
    SLOW,
  )

  it(
    'two plugins failing in the same hour trip independently',
    async () => {
      const companyId = await seedCompany()
      const root = newPluginsRoot()
      install(root, 'throws')
      writeFailing(root, 'flaky', { delayMs: 0, concurrency: 1 })
      const throws = await row('throws')
      const flaky = await row('flaky')
      await boot(root)

      // Six failures in the hour between them, three each: neither trips.
      for (let i = 0; i < 3; i++) {
        await run(BOOM, { entityId: companyId })
        await run('plugin.flaky.ping', { entityId: companyId })
      }
      expect((await rowOf(throws.id)).status).toBe('enabled')
      expect((await rowOf(flaky.id)).status).toBe('enabled')

      for (let i = 0; i < 2; i++) await run(BOOM, { entityId: companyId })
      expect((await rowOf(throws.id)).status).toBe('disabled')
      expect((await rowOf(flaky.id)).status).toBe('enabled')

      for (let i = 0; i < 2; i++)
        await run('plugin.flaky.ping', { entityId: companyId })
      expect(await rowOf(flaky.id)).toMatchObject({
        status: 'disabled',
        lastError: BREAKER_REASON,
        errorCount: 5,
      })
      expect(breakerGroup('flaky')).toBe('plugin.flaky.')
    },
    SLOW,
  )

  it(
    'tripping on the fifth of several jobs in flight neither deadlocks nor drops one',
    async () => {
      const companyId = await seedCompany()
      const root = newPluginsRoot()
      writeFailing(root, 'slow', { delayMs: 300, concurrency: 3 })
      const slow = await row('slow')
      const { host } = await boot(root)

      const queue = 'plugin.slow.ping'
      const ids = await Promise.all(
        Array.from({ length: 8 }, () => send(queue, { entityId: companyId })),
      )
      // The release waits out every job in flight; a deadlock never gets here.
      expect(
        await waitFor(
          () => host.granted(slow.id, 'ping'),
          (granted) => granted === null,
        ),
      ).toBeNull()

      const runs = await runsOf(slow.id)
      expect(runs.length).toBeGreaterThanOrEqual(5)
      expect(runs.every((r) => r.status === 'failed')).toBe(true)
      const states = await Promise.all(ids.map((id) => stateOf(queue, id)))
      // Every job that started finished; the rest wait for a reset.
      expect(states.filter((s) => s === 'cancelled')).toHaveLength(runs.length)
      expect(states.filter((s) => s === 'created')).toHaveLength(
        8 - runs.length,
      )
      expect(await rowOf(slow.id)).toMatchObject({
        status: 'disabled',
        errorCount: runs.length,
      })
    },
    SLOW,
  )
})

describe('a tripped plugin stays tripped until its row is reset', () => {
  it(
    'a worker restart does not re-enable it; a reset by SQL does',
    async () => {
      const companyId = await seedCompany()
      const root = newPluginsRoot()
      install(root, 'throws')
      const throws = await row('throws')
      const first = await boot(root)
      for (let i = 0; i < 5; i++) await run(BOOM, { entityId: companyId })
      await waitFor(
        () => first.host.granted(throws.id, 'boom'),
        (granted) => granted === null,
      )

      // A new process: boss.stop stops the work, a new host reconciles.
      await Effect.runPromise(first.host.shutdown())
      const second = await boot(root)
      expect(second.loader.map((v) => [v.id, v.status, v.reason])).toEqual([
        ['throws', 'disabled', BREAKER_REASON],
      ])
      expect(second.loaded).toEqual([])
      expect(await rowOf(throws.id)).toMatchObject({
        enabled: true,
        status: 'disabled',
        lastError: BREAKER_REASON,
      })
      expect(await unworked(FINE, { entityId: companyId })).toBe('created')

      // The reset: the next boot loads it, and one failure does not re-trip it.
      await reset(throws.id)
      await Effect.runPromise(second.host.shutdown())
      const third = await boot(root)
      expect(third.verdicts.map((v) => [v.id, v.status])).toEqual([
        ['throws', 'enabled'],
      ])
      expect(await run(BOOM, { entityId: companyId })).toBe('cancelled')
      expect(await rowOf(throws.id)).toMatchObject({
        status: 'enabled',
        errorCount: 1,
      })
    },
    SLOW,
  )
})

describe('runJob — a breaker trip inside one batch', () => {
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
  const settledHost = (outcomes: Array<string>): JobHost => {
    const note = async (_q: string, _id: string, o: JobOutcome) => {
      outcomes.push(o.kind)
    }
    return {
      complete: note,
      fail: note,
      failTerminal: note,
      send: async () => undefined,
    }
  }

  it('settles and closes every job of the batch and trips once, on the fifth', async () => {
    const batch = await row('batcher')
    const queue = 'plugin.batcher.ping'
    const outcomes: Array<string> = []
    /** How many jobs had settled each time the breaker tripped. */
    const trips: Array<number> = []
    const handler = runJob(
      {
        name: queue,
        schema: z.object({}),
        run: () => Effect.fail(new JobPermanent({ reason: 'nope' })),
        refs: () => ({ integrationId: batch.id }),
      },
      {
        host: settledHost(outcomes),
        layer: Layer.empty,
        breaker: {
          integrationId: batch.id,
          group: breakerGroup('batcher'),
          onTrip: () => {
            trips.push(outcomes.length)
          },
        },
      },
    )
    await handler(Array.from({ length: 7 }, () => fakeJob(queue, {})))

    expect(outcomes).toEqual(Array.from({ length: 7 }, () => 'permanent'))
    expect(trips).toEqual([5])
    const runs = await db
      .select()
      .from(jobRun)
      .where(and(eq(jobRun.queue, queue), eq(jobRun.integrationId, batch.id)))
    expect(runs.map((r) => r.status)).toEqual(
      Array.from({ length: 7 }, () => 'failed'),
    )
    expect(await rowOf(batch.id)).toMatchObject({
      status: 'disabled',
      lastError: BREAKER_REASON,
      errorCount: 7,
    })
  })

  it('a throttle is not a failure', async () => {
    const limited = await row('limited')
    const queue = 'plugin.limited.ping'
    const handler = runJob(
      {
        name: queue,
        schema: z.object({}),
        run: () =>
          Effect.fail(
            new JobRateLimited({ reason: 'slow down', retryAfterMs: 1000 }),
          ),
        refs: () => ({ integrationId: limited.id }),
      },
      {
        host: settledHost([]),
        layer: Layer.empty,
        breaker: {
          integrationId: limited.id,
          group: breakerGroup('limited'),
          onTrip: () => undefined,
        },
      },
    )
    await handler(Array.from({ length: 6 }, () => fakeJob(queue, {})))
    const after = await rowOf(limited.id)
    expect(after.status).not.toBe('disabled')
    expect(after).toMatchObject({ errorCount: 0, lastError: null })
  })
})
