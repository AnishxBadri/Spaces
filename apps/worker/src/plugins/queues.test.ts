import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Layer } from 'effect'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
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
import type { JobDeclaration } from '@spaces/sdk'
import { pgBossHost } from '../run-job'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import type { LoadedPlugin } from './loader'
import { durationMs } from './queues'

/**
 * Loader step seven against a real pg-boss on this worker's test database:
 * the echo and syncer fixtures registered as `plugin.<id>.<job>` queues,
 * run through `runJob`, scheduled, unregistered and drained. A scheduled
 * tick is a `send` onto the queue — exactly what pg-boss's cron does — so
 * no test waits for a clock.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const MESSAGES_URL = 'https://mail.example/v1/messages'

let boss: PgBoss

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined) throw new Error('DATABASE_URL is unset')
  boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    // The cron clock and maintenance stay off: a test sends its own ticks.
    schedule: false,
    supervise: false,
  })
  boss.on('error', (error: Error) => console.error('[pg-boss]', error))
  await boss.start()
  // The `pgboss` schema outlives the per-file truncate: start from no
  // plugin queue, job or schedule.
  for (const queue of await boss.getQueues())
    if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
})

afterAll(async () => {
  await boss.stop({ graceful: false })
})

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-queues-')),
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

/** A one-job bundle written by hand, its `ping` job declared as given. */
const writeBundle = (
  root: string,
  id: string,
  ping: Record<string, unknown>,
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
      description: 'A queue registration test bundle.',
      settings: {},
      jobs: { ping },
    }),
  )
  writeFileSync(
    path.join(dir, 'bundle.mjs'),
    [
      "import { Effect } from 'effect'",
      "import { z } from 'zod'",
      'export default {',
      `  manifest: { id: '${id}', settings: z.object({}) },`,
      '  jobs: { ping: () => Effect.void },',
      '}',
    ].join('\n'),
  )
}

/** A bundle of action jobs written by hand: each job's declaration and body. */
const writeJobs = (
  root: string,
  id: string,
  jobs: Record<string, { declared: Record<string, unknown>; body: string }>,
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
      description: 'A queue registration test bundle.',
      settings: {},
      jobs: Object.fromEntries(
        Object.entries(jobs).map(([name, job]) => [name, job.declared]),
      ),
    }),
  )
  writeFileSync(
    path.join(dir, 'bundle.mjs'),
    [
      "import { Effect } from 'effect'",
      "import { z } from 'zod'",
      'export default {',
      `  manifest: { id: '${id}', settings: z.object({}) },`,
      '  jobs: {',
      ...Object.entries(jobs).map(([name, job]) => `    ${name}: ${job.body},`),
      '  },',
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

const cursorsOf = async (id: string) =>
  (
    await db
      .select({ cursors: integration.cursors })
      .from(integration)
      .where(eq(integration.id, id))
  ).at(0)?.cursors

/** The provider's pages: no cursor → page-2 → page-3 → the end. */
const NEXT: Record<string, string | null> = {
  start: 'page-2',
  'page-2': 'page-3',
  'page-3': null,
}

/** A cursor the provider answers 503 for. */
const UNAVAILABLE = 'page-9'

const fetched: Array<string> = []
const fakeFetch = (url: string) => {
  fetched.push(url)
  const cursor = new URL(url).searchParams.get('cursor') ?? 'start'
  if (cursor === UNAVAILABLE)
    return Promise.resolve(new Response('unavailable', { status: 503 }))
  return Promise.resolve(
    new Response(
      JSON.stringify({ messages: [], nextCursor: NEXT[cursor] ?? null }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  )
}

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []

const newHost = () => {
  const host = makePluginHost({
    enqueue: noEnqueue,
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    fetch: fakeFetch,
    sink: () => undefined,
  })
  hosts.push(host)
  return host
}

const load = async (root: string) =>
  (await Effect.runPromise(reconcilePlugins({ pluginsRoot: root }))).loaded

const boot = async (root: string) => {
  const host = newHost()
  const loaded = await load(root)
  const verdicts = await Effect.runPromise(host.wire(loaded))
  return { host, loaded, verdicts }
}

/** A worker restart as the process sees it: `boss.stop` stops the work. */
const restart = async (host: PluginHost, queues: ReadonlyArray<string>) => {
  for (const queue of queues) await boss.offWork(queue)
  await Effect.runPromise(host.shutdown())
}

const waitFor = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
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

const settled = (queue: string, id: string) =>
  waitFor(
    () => stateOf(queue, id),
    (state) => state === 'completed' || state === 'failed',
  )

/**
 * pg-boss marks the job completed before `runJob` closes its `job_run` row
 * (and, for a schedule job, writes the cursor in that same transaction), so
 * a cursor read right after `settled` can be one commit early.
 */
const cursorsSettled = (
  integrationId: string,
  changedFrom: Awaited<ReturnType<typeof cursorsOf>>,
) =>
  waitFor(
    () => cursorsOf(integrationId),
    (cursors) => JSON.stringify(cursors) !== JSON.stringify(changedFrom),
  )

const send = async (queue: string, data: object) => {
  const id = await boss.send(queue, data)
  if (id === null) throw new Error(`${queue} refused the job`)
  return id
}

/** One integration's `job_run` rows on one queue; rows outlive a test within the file. */
const runsOf = (queue: string, integrationId: string) =>
  db
    .select()
    .from(jobRun)
    .where(
      and(eq(jobRun.queue, queue), eq(jobRun.integrationId, integrationId)),
    )

const scheduleRows = async (prefix: string) =>
  (
    await db.execute<{ name: string; cron: string }>(
      sql`select name, cron from pgboss.schedule where name like ${`${prefix}%`} order by name`,
    )
  ).rows

const seedCompany = async () =>
  (
    await resolveEntity({
      kind: 'company',
      name: 'Northwind Robotics',
      keys: { domain: 'northwind-robotics.example' },
      source: { class: 'manual' },
    })
  ).entityId

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
  fetched.splice(0)
})

describe('every declared job is a queue', () => {
  it("echo's echo job runs end to end through runJob and leaves a job_run row naming the integration", async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo')
    const { verdicts } = await boot(root)
    expect(verdicts.map((v) => [v.id, v.status])).toEqual([['echo', 'enabled']])
    for (const queue of ['plugin.echo.echo', 'plugin.echo.enrich'])
      expect(await boss.getQueue(queue)).toMatchObject({
        name: queue,
        policy: 'standard',
        retryLimit: 2,
      })

    const id = await send('plugin.echo.echo', { entityId: companyId })
    expect(await settled('plugin.echo.echo', id)).toBe('completed')

    const runs = await runsOf('plugin.echo.echo', echo.id)
    expect(runs).toHaveLength(1)
    expect(runs.at(0)).toMatchObject({
      integrationId: echo.id,
      entityId: companyId,
      status: 'succeeded',
      attempt: 1,
    })
  })

  it("the manifest's concurrency, timeout and retry are the work and queue options, and an interactive job has its own queue", async () => {
    const work = vi.spyOn(boss, 'work')
    const root = newPluginsRoot()
    writeBundle(root, 'tuned', {
      trigger: 'action',
      uses: ['Log'],
      concurrency: 3,
      timeout: '30s',
      retry: 5,
      interactive: true,
    })
    await row('tuned')
    await boot(root)

    expect(await boss.getQueue('plugin.tuned.ping')).toBeNull()
    expect(await boss.getQueue('plugin.tuned.ping.interactive')).toMatchObject({
      retryLimit: 5,
      retryBackoff: true,
      expireInSeconds: 30 + 60,
    })
    const call = work.mock.calls.find(
      ([name]) => name === 'plugin.tuned.ping.interactive',
    )
    expect(call?.at(1)).toMatchObject({
      batchSize: 1,
      includeMetadata: true,
      localConcurrency: 3,
    })
    work.mockRestore()
  })

  it('reads manifest durations', () => {
    expect(['500ms', '60s', '5m', '1h'].map(durationMs)).toEqual([
      500, 60_000, 300_000, 3_600_000,
    ])
  })
})

describe('an interactive job', () => {
  it('is interrupted at its manifest timeout and closes its job_run row failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    writeJobs(root, 'stuck', {
      hang: {
        declared: {
          trigger: 'action',
          uses: ['Log'],
          timeout: '1s',
          retry: 0,
          interactive: true,
        },
        body: '() => Effect.never',
      },
    })
    const stuck = await row('stuck')
    await boot(root)
    const queue = 'plugin.stuck.hang.interactive'
    expect(await boss.getQueue(queue)).toMatchObject({
      expireInSeconds: 1 + 60,
    })

    const id = await send(queue, { entityId: companyId })
    expect(await settled(queue, id)).toBe('failed')
    const runs = await waitFor(
      () => runsOf(queue, stuck.id),
      (rows) => rows.length > 0 && rows.every((r) => r.status !== 'running'),
    )
    expect(runs.map((r) => r.status)).toEqual(['failed'])
    expect(runs.at(0)?.error).toContain('exceeded its 1s timeout')
    vi.restoreAllMocks()
  })

  it('runs while a batch job of the same plugin holds every slot of its own queue', async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    writeJobs(root, 'busy', {
      slow: {
        declared: { trigger: 'action', uses: ['Log'], timeout: '10s' },
        body: "() => Effect.sleep('3 seconds')",
      },
      ping: {
        declared: { trigger: 'action', uses: ['Log'], interactive: true },
        body: '() => Effect.void',
      },
    })
    await row('busy')
    await boot(root)

    const first = await send('plugin.busy.slow', { entityId: companyId })
    const second = await send('plugin.busy.slow', { entityId: companyId })
    await waitFor(
      () => stateOf('plugin.busy.slow', first),
      (state) => state === 'active',
    )
    const ping = await send('plugin.busy.ping.interactive', {
      entityId: companyId,
    })
    expect(await settled('plugin.busy.ping.interactive', ping)).toBe(
      'completed',
    )
    // The batch queue is still saturated: its first job running, its next waiting.
    expect(await stateOf('plugin.busy.slow', first)).toBe('active')
    expect(await stateOf('plugin.busy.slow', second)).toBe('created')
  })
})

describe('a schedule job', () => {
  it("syncer's sync is scheduled at its cron, and its cursor survives a worker restart", async () => {
    const root = newPluginsRoot()
    install(root, 'syncer')
    const syncer = await row('syncer')
    const first = await boot(root)
    expect(await scheduleRows('plugin.syncer.')).toEqual([
      { name: 'plugin.syncer.sync', cron: '*/15 * * * *' },
    ])
    expect(await boss.getQueue('plugin.syncer.sync')).toMatchObject({
      policy: 'singleton',
    })
    expect(await cursorsOf(syncer.id)).toBeNull()

    const tick = await send('plugin.syncer.sync', {})
    expect(await settled('plugin.syncer.sync', tick)).toBe('completed')
    expect(fetched).toEqual([MESSAGES_URL])
    expect(await cursorsSettled(syncer.id, null)).toEqual({ sync: 'page-2' })
    const run = (await runsOf('plugin.syncer.sync', syncer.id)).at(0)
    expect(run).toMatchObject({
      integrationId: syncer.id,
      status: 'succeeded',
      summary: 'nextCursor page-2',
    })

    // A new process: new host, new reconciliation, the cursor from the row.
    await restart(first.host, ['plugin.syncer.sync'])
    await boot(root)
    const next = await send('plugin.syncer.sync', {})
    expect(await settled('plugin.syncer.sync', next)).toBe('completed')
    expect(fetched).toEqual([MESSAGES_URL, `${MESSAGES_URL}?cursor=page-2`])
    expect(await cursorsSettled(syncer.id, { sync: 'page-2' })).toEqual({
      sync: 'page-3',
    })

    const last = await send('plugin.syncer.sync', {})
    expect(await settled('plugin.syncer.sync', last)).toBe('completed')
    expect(await cursorsSettled(syncer.id, { sync: 'page-3' })).toEqual({
      sync: null,
    })
  })

  it('a failed run leaves the cursor where it was', async () => {
    const root = newPluginsRoot()
    install(root, 'syncer')
    const syncer = await row('syncer')
    await db
      .update(integration)
      .set({ cursors: { sync: UNAVAILABLE } })
      .where(eq(integration.id, syncer.id))
    await boot(root)

    const tick = await send('plugin.syncer.sync', {})
    expect(
      await waitFor(
        () => stateOf('plugin.syncer.sync', tick),
        (state) => state === 'retry' || state === 'failed',
      ),
    ).toBe('retry')
    expect(fetched).toEqual([`${MESSAGES_URL}?cursor=${UNAVAILABLE}`])
    const runs = await waitFor(
      () => runsOf('plugin.syncer.sync', syncer.id),
      (rows) => rows.length > 0 && rows.every((r) => r.status !== 'running'),
    )
    expect(await cursorsOf(syncer.id)).toEqual({ sync: UNAVAILABLE })
    expect(runs.map((r) => r.status)).toEqual(['failed'])
    expect(runs.at(0)?.error).toContain('retryable:')
  })

  it('removing the schedule from the manifest and reconciling unschedules it', async () => {
    const root = newPluginsRoot()
    install(root, 'syncer')
    await row('syncer')
    const first = await boot(root)
    expect(await scheduleRows('plugin.syncer.')).toHaveLength(1)

    // The upgrade, as the next process loads it: same job, no schedule.
    await restart(first.host, ['plugin.syncer.sync'])
    const withoutSchedule = (job: JobDeclaration): JobDeclaration => ({
      trigger: job.trigger,
      uses: job.uses,
    })
    const upgraded = (await load(root)).map((plugin): LoadedPlugin => ({
      ...plugin,
      manifest: {
        ...plugin.manifest,
        jobs: Object.fromEntries(
          Object.entries(plugin.manifest.jobs).map(([name, job]) => [
            name,
            withoutSchedule(job),
          ]),
        ),
      },
    }))
    const host = newHost()
    await Effect.runPromise(host.wire(upgraded))
    expect(await scheduleRows('plugin.syncer.')).toEqual([])
    // The queue is still worked; only the cron is gone.
    expect(await boss.getQueue('plugin.syncer.sync')).not.toBeNull()
  })
})

describe('release and re-enable', () => {
  it('a job sent while the plugin is released stays queued, and re-enabling drains it', async () => {
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'echo')
    install(root, 'syncer')
    const echo = await row('echo')
    const syncer = await row('syncer')
    const { host, loaded } = await boot(root)

    const released = await Effect.runPromise(host.release(echo.id))
    expect(released?.status).toBe('released')
    await Effect.runPromise(host.release(syncer.id))
    expect(await scheduleRows('plugin.syncer.')).toEqual([])

    const id = await send('plugin.echo.echo', { entityId: companyId })
    // Three polling intervals: nobody is working the queue.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await stateOf('plugin.echo.echo', id)).toBe('created')
    expect(await runsOf('plugin.echo.echo', echo.id)).toEqual([])

    await Effect.runPromise(host.wire(loaded))
    expect(await settled('plugin.echo.echo', id)).toBe('completed')
    expect(await scheduleRows('plugin.syncer.')).toHaveLength(1)
    const runs = await runsOf('plugin.echo.echo', echo.id)
    expect(runs.map((r) => [r.entityId, r.status])).toEqual([
      [companyId, 'succeeded'],
    ])
  })
})
