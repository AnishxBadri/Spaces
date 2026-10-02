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
import { enrichmentRecord, integration, jobRun } from '@spaces/db/schema'
import type { IntegrationConfig } from '@spaces/db/schema/integrations'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { stoppedPluginsProgram } from '#web/lib/integrations/status'
import { pgBossHost } from '../run-job'
import { spendToday } from './credit'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import type { LoadedPlugin } from './loader'
import {
  breakerGroup,
  pluginQueues,
  registerQueues,
  unregisterQueues,
} from './queues'
import type { PluginQueue, PluginQueuesOptions } from './queues'

/**
 * The credit guard around an action job, against a real pg-boss on this
 * worker's test database: the cache skip, the daily cap, spend read back
 * from `enrichment_record` across a restart, and a job with no `cost` hook.
 * A guarded job that does no work still settles `completed` in pg-boss and
 * leaves a `skipped` `job_run` row naming why.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const DAY_MS = 24 * 60 * 60 * 1000

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
    if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
})

afterAll(async () => {
  await boss.stop({ graceful: false })
})

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-credit-')),
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

/** A one-job bundle whose action job `ping` is the given export source. */
const writeBundle = (root: string, id: string, ping: string) => {
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
      description: 'A credit guard test bundle.',
      settings: {},
      jobs: { ping: { trigger: 'action', uses: ['Log'] } },
    }),
  )
  writeFileSync(
    path.join(dir, 'bundle.mjs'),
    [
      "import { Effect } from 'effect'",
      "import { z } from 'zod'",
      'export default {',
      `  manifest: { id: '${id}', settings: z.object({}) },`,
      `  jobs: { ping: ${ping} },`,
      '}',
    ].join('\n'),
  )
}

const row = async (capabilityId: string, config: IntegrationConfig = {}) => {
  const inserted = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true, config })
      .returning()
  ).at(0)
  if (!inserted) throw new Error('no integration row')
  return inserted
}

const seedCompany = async (domain: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name: domain,
      keys: { domain },
      source: { class: 'manual' },
    })
  ).entityId

/** A receipt as `Receipts.store` leaves it, dated `fetchedAt`. */
const receipt = async (
  integrationId: string,
  entityId: string,
  creditsUsed: number,
  fetchedAt: Date | null = null,
) => {
  await db.insert(enrichmentRecord).values({
    entityId,
    integrationId,
    provider: 'test',
    raw: {},
    creditsUsed,
    ...(fetchedAt === null ? {} : { fetchedAt }),
  })
}

/** Every URL the provider was asked for: the proof a guarded job made no call. */
const fetched: Array<string> = []
const fakeFetch = (url: string) => {
  fetched.push(url)
  const domain = new URL(url).searchParams.get('domain') ?? ''
  return Promise.resolve(
    new Response(
      JSON.stringify({
        organization: {
          name: `Company at ${domain}`,
          primary_domain: domain,
          founded_year: 2019,
        },
        credits_consumed: 1,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  )
}

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const queuesOptions = (): PluginQueuesOptions => ({
  boss,
  host: pgBossHost(boss),
  pollingIntervalSeconds: 0.5,
})

const hosts: Array<PluginHost> = []
const registered: Array<ReadonlyArray<PluginQueue>> = []

const load = async (root: string) =>
  (await Effect.runPromise(reconcilePlugins({ pluginsRoot: root }))).loaded

/** The host as the worker boots it: it registers each plugin's queues itself. */
const boot = async (root: string) => {
  const host = makePluginHost({
    enqueue: noEnqueue,
    queues: queuesOptions(),
    fetch: fakeFetch,
    sink: () => undefined,
  })
  hosts.push(host)
  await Effect.runPromise(host.wire(await load(root)))
  return host
}

/**
 * The host wiring each job's ports, with the queues registered here from
 * the plans `pluginQueues` makes from the manifest and the bundle's job
 * exports — so an action job's `cost` hook reaches the guard.
 */
const bootWithCost = async (root: string) => {
  const host = makePluginHost({
    enqueue: noEnqueue,
    fetch: fakeFetch,
    sink: () => undefined,
  })
  hosts.push(host)
  const loaded = await load(root)
  await Effect.runPromise(host.wire(loaded))
  for (const plugin of loaded) await registerWithCost(host, plugin)
  return host
}

const registerWithCost = async (host: PluginHost, plugin: LoadedPlugin) => {
  const plans = pluginQueues(plugin.manifest, plugin.jobs)
  registered.push(plans)
  await Effect.runPromise(
    registerQueues(queuesOptions(), plugin.integrationId, plans, host.invoke, {
      integrationId: plugin.integrationId,
      group: breakerGroup(plugin.manifest.id),
      onTrip: () => undefined,
    }),
  )
}

/** A worker restart: the old host's work stops and a new one boots. */
const restart = async (root: string) => {
  for (const plans of registered.splice(0))
    await Effect.runPromise(unregisterQueues(queuesOptions(), plans))
  for (const host of hosts.splice(0)) await Effect.runPromise(host.shutdown())
  return bootWithCost(root)
}

afterEach(async () => {
  for (const plans of registered.splice(0))
    await Effect.runPromise(unregisterQueues(queuesOptions(), plans))
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
  fetched.splice(0)
})

const waitFor = async <T>(
  read: () => Promise<T>,
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

const send = async (queue: string, data: object) => {
  const id = await boss.send(queue, data)
  if (id === null) throw new Error(`${queue} refused the job`)
  return id
}

/**
 * Waits for `n` closed `job_run` rows: pg-boss settles a job before
 * `runJob` closes its row, so the row is what a test waits on.
 */
const closedRuns = (queue: string, integrationId: string, n: number) =>
  waitFor(
    () =>
      db
        .select()
        .from(jobRun)
        .where(
          and(eq(jobRun.queue, queue), eq(jobRun.integrationId, integrationId)),
        )
        .orderBy(jobRun.startedAt),
    (rows) => rows.length >= n && rows.every((r) => r.status !== 'running'),
  )

const stateOf = async (queue: string, id: string) =>
  (await boss.getJobById(queue, id))?.state ?? null

describe('the cache', () => {
  it('skips an entity whose latest receipt from this integration is younger than cacheDays, with no provider call', async () => {
    const companyId = await seedCompany('cached-twelve.example')
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo')
    // Another integration's fresh receipt is not this one's cache.
    const other = await row('other')
    await receipt(other.id, companyId, 1)
    await receipt(echo.id, companyId, 1, new Date(Date.now() - 12.5 * DAY_MS))
    await boot(root)

    const id = await send('plugin.echo.enrich', { entityId: companyId })
    const runs = await closedRuns('plugin.echo.enrich', echo.id, 1)
    expect(runs.map((r) => [r.status, r.summary, r.error])).toEqual([
      ['skipped', 'cached (enriched 12 days ago)', null],
    ])
    expect(fetched).toEqual([])
    expect(await stateOf('plugin.echo.enrich', id)).toBe('completed')
    expect((await boss.getJobById('plugin.echo.enrich', id))?.output).toEqual(
      expect.objectContaining({ kind: 'skipped' }),
    )
    // A cache skip is not a refusal: Today does not list it.
    expect(
      (await Effect.runPromise(stoppedPluginsProgram())).filter(
        (p) => p.integrationId === echo.id,
      ),
    ).toEqual([])
  })

  it('enriching twice: the second run is cached, 0 credits, and its row is skipped', async () => {
    const companyId = await seedCompany('twice.example')
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo')
    await boot(root)
    const logged = vi.spyOn(console, 'log')

    await send('plugin.echo.enrich', { entityId: companyId })
    await closedRuns('plugin.echo.enrich', echo.id, 1)
    await send('plugin.echo.enrich', { entityId: companyId })
    const runs = await closedRuns('plugin.echo.enrich', echo.id, 2)

    expect(runs.map((r) => [r.status, r.summary])).toEqual([
      ['succeeded', null],
      ['skipped', 'cached (enriched 0 days ago)'],
    ])
    expect(fetched).toHaveLength(1)
    expect(logged.mock.calls.map((c) => String(c.at(0))).join('\n')).toContain(
      'skipped, 0 credits — cached (enriched 0 days ago)',
    )
    logged.mockRestore()
  })

  it('reads cacheDays from integration.config', async () => {
    const companyId = await seedCompany('short-cache.example')
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo', { cacheDays: 10 })
    await receipt(echo.id, companyId, 1, new Date(Date.now() - 12.5 * DAY_MS))
    await boot(root)

    await send('plugin.echo.enrich', { entityId: companyId })
    const runs = await closedRuns('plugin.echo.enrich', echo.id, 1)
    expect(runs.map((r) => r.status)).toEqual(['succeeded'])
    expect(fetched).toHaveLength(1)
  })
})

describe('the daily cap', () => {
  it('with dailyCreditCap 2 and a cost of 1, the third job of the day is refused before any Http call', async () => {
    const companies = [
      await seedCompany('cap-one.example'),
      await seedCompany('cap-two.example'),
      await seedCompany('cap-three.example'),
    ]
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo', { dailyCreditCap: 2 })
    await bootWithCost(root)

    for (const entityId of companies)
      await send('plugin.echo.enrich', { entityId })
    const runs = await closedRuns('plugin.echo.enrich', echo.id, 3)

    expect(runs.map((r) => [r.status, r.summary])).toEqual([
      ['succeeded', null],
      ['succeeded', null],
      ['skipped', 'daily credit cap (2) reached'],
    ])
    expect(fetched).toHaveLength(2)
    expect(await Effect.runPromise(spendToday(echo.id))).toBe(2)

    // Today's plugin lines: one, naming the cap and the refusals.
    expect(
      (await Effect.runPromise(stoppedPluginsProgram())).filter(
        (p) => p.integrationId === echo.id,
      ),
    ).toEqual([
      {
        integrationId: echo.id,
        pluginId: 'echo',
        state: 'capped',
        reason: 'daily credit cap (2) reached',
        refused: 1,
      },
    ])
  })

  it('refuses a job whose cost estimate alone does not fit, without running it', async () => {
    const companyId = await seedCompany('dear.example')
    const root = newPluginsRoot()
    writeBundle(
      root,
      'dear',
      "{ run: () => Effect.die(new Error('ran')), cost: ({ entityIds }) => ({ credits: 3 * entityIds.length }) }",
    )
    const dear = await row('dear', { dailyCreditCap: 2 })
    await bootWithCost(root)

    await send('plugin.dear.ping', { entityId: companyId })
    const runs = await closedRuns('plugin.dear.ping', dear.id, 1)
    // Had it run, the defect would have failed the row.
    expect(runs.map((r) => [r.status, r.summary])).toEqual([
      ['skipped', 'daily credit cap (2) reached'],
    ])
  })

  it('fails a job whose cost hook returns no { credits }, permanently', async () => {
    const companyId = await seedCompany('broken-cost.example')
    const root = newPluginsRoot()
    writeBundle(
      root,
      'broken',
      "{ run: () => Effect.void, cost: () => ({ credits: 'many' }) }",
    )
    const broken = await row('broken', { dailyCreditCap: 2 })
    await bootWithCost(root)

    await send('plugin.broken.ping', { entityId: companyId })
    const runs = await closedRuns('plugin.broken.ping', broken.id, 1)
    expect(runs.map((r) => r.status)).toEqual(['failed'])
    expect(runs.at(0)?.error).toContain(
      'permanent: the cost hook did not return { credits }',
    )
  })
})

describe('spend', () => {
  it('is per integration per UTC day from enrichment_record, and a restarted guard reads the same total', async () => {
    const [first, second, third] = [
      await seedCompany('spend-one.example'),
      await seedCompany('spend-two.example'),
      await seedCompany('spend-three.example'),
    ]
    const root = newPluginsRoot()
    install(root, 'echo')
    const echo = await row('echo', { dailyCreditCap: 3 })
    const other = await row('other')
    const midnight = (
      await db.execute<{ at: string }>(
        sql`select (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')::text as at`,
      )
    ).rows.at(0)?.at
    if (midnight === undefined) throw new Error('no midnight')
    const yesterday = new Date(new Date(midnight).getTime() - 60_000)
    // Today's two credits count; yesterday's and another integration's do not.
    await receipt(echo.id, first, 2)
    await receipt(echo.id, first, 5, yesterday)
    await receipt(other.id, first, 7)
    await bootWithCost(root)
    expect(await Effect.runPromise(spendToday(echo.id))).toBe(2)

    // 2 + 1 fits under 3: it runs and its receipt brings the day to 3.
    await send('plugin.echo.enrich', { entityId: second })
    await closedRuns('plugin.echo.enrich', echo.id, 1)
    expect(await Effect.runPromise(spendToday(echo.id))).toBe(3)

    // A new process reads the same total from the receipts and refuses.
    await restart(root)
    expect(await Effect.runPromise(spendToday(echo.id))).toBe(3)
    await send('plugin.echo.enrich', { entityId: third })
    const runs = await closedRuns('plugin.echo.enrich', echo.id, 2)
    expect(runs.map((r) => [r.status, r.summary])).toEqual([
      ['succeeded', null],
      ['skipped', 'daily credit cap (3) reached'],
    ])
    expect(fetched).toHaveLength(1)
  })
})

describe('a job with no cost hook', () => {
  it('runs below the cap and is refused by the host once the day’s receipts reach it', async () => {
    const companyId = await seedCompany('no-cost.example')
    // Receipts on another record, so the cache never answers for this one.
    const spentOn = await seedCompany('no-cost-spent.example')
    const root = newPluginsRoot()
    writeBundle(root, 'free', '() => Effect.void')
    const free = await row('free', { dailyCreditCap: 2 })
    await receipt(free.id, spentOn, 1)
    await boot(root)

    await send('plugin.free.ping', { entityId: companyId })
    await closedRuns('plugin.free.ping', free.id, 1)
    await receipt(free.id, spentOn, 1)
    await send('plugin.free.ping', { entityId: companyId })
    const runs = await closedRuns('plugin.free.ping', free.id, 2)

    expect(runs.map((r) => [r.status, r.summary])).toEqual([
      ['succeeded', null],
      ['skipped', 'daily credit cap (2) reached'],
    ])
  })
})
