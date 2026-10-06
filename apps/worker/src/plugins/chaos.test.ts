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
import {
  enrichmentRecord,
  entity,
  integration,
  jobRun,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { storeCredential } from '@spaces/core/writes/vault'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pgBossHost } from '../run-job'
import { ENRICHERS, pluginsRootWith } from './fakes/enrichers'
import type { Enricher } from './fakes/enrichers'
import { cassetteProviders } from './fakes/registry'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import type { PluginQueuesOptions } from './queues'

/**
 * The chaos list (spec §13.7), run against each enricher's provider fake:
 * the real bundle, loaded and wired as boot does it, its queue worked by a
 * real pg-boss through `runJob` on this worker's test database. The fake is
 * the only provider; `fetch` itself throws, so nothing reaches a network.
 *
 * - 429 with Retry-After: the request waits what the provider asked, and a
 *   429 that persists re-sends the job for then without spending a retry.
 * - A key revoked mid-run fails the next job permanently, at once, with the
 *   provider's sentence — never a hang, never the key in the error.
 * - Half a failing batch: the half that succeeded is written; the failing
 *   half is retryable and wrote nothing.
 */

let boss: PgBoss

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the chaos suite must not reach the network')
  })
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
  await dropPluginQueues()
})

afterAll(async () => {
  await dropPluginQueues()
  await boss.stop({ graceful: false })
  vi.unstubAllGlobals()
})

async function dropPluginQueues() {
  for (const queue of await boss.getQueues())
    if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
}

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  await dropPluginQueues()
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const queuesOptions = (): PluginQueuesOptions => ({
  boss,
  host: pgBossHost(boss),
  pollingIntervalSeconds: 0.5,
})

/** Every line the plugin logged, for the key-never-written assertions. */
const logged: Array<string> = []

/**
 * One enricher installed, its row written (keyed when `secret` is given),
 * loaded and wired with its provider fake standing in.
 */
const boot = async (enricher: Enricher, secret?: string) => {
  const root = pluginsRootWith('chaos', [enricher.id])
  const credentialId =
    secret === undefined
      ? null
      : (
          await storeCredential({
            scope: 'workspace',
            provider: enricher.id,
            kind: 'enrichment',
            secret,
            createdBy: FIXTURE_ACTOR.id,
          })
        ).id
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: enricher.id,
        version: '0.1.0',
        enabled: true,
        credentialId,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no integration row')
  const fakes = cassetteProviders()
  const fake = fakes.provider(enricher.id)
  if (fake === null) throw new Error(`${enricher.id} has no cassette`)
  const host = makePluginHost({
    enqueue: noEnqueue,
    queues: queuesOptions(),
    fakes,
    sink: (_level, line) => {
      logged.push(line)
    },
  })
  hosts.push(host)
  const { loaded, verdicts } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root, only: enricher.id, fakes }),
  )
  expect(verdicts.map((v) => v.status)).toEqual(['enabled'])
  await Effect.runPromise(host.wire(loaded))
  return { row, fake, queue: `plugin.${enricher.id}.${enricher.companyJob}` }
}

const seedCompany = async (name: string, domain: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      keys: { domain },
      source: { class: 'manual' },
    })
  ).entityId

const send = async (queue: string, entityId: string) => {
  const id = await boss.send(queue, { entityId })
  if (id === null) throw new Error(`${queue} refused the job`)
  return id
}

const waitFor = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> => {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** `n` closed `job_run` rows: pg-boss settles a job before `runJob` closes its row. */
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

const valuesOf = async (entityId: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)?.values ?? {}

const receiptsFor = async (integrationId: string) =>
  db
    .select({ entityId: enrichmentRecord.entityId })
    .from(enrichmentRecord)
    .where(eq(enrichmentRecord.integrationId, integrationId))

const errorCountOf = async (integrationId: string) =>
  (
    await db
      .select({ errorCount: integration.errorCount })
      .from(integration)
      .where(eq(integration.id, integrationId))
  ).at(0)?.errorCount

describe('the database this suite writes', () => {
  it('is an isolated test database, never the dev one', async () => {
    const name = (
      await db.execute<{ name: string }>(sql`select current_database() as name`)
    ).rows.at(0)?.name
    expect(name).toMatch(/_test/)
    expect(name).not.toBe('spaces')
  })
})

describe.each(ENRICHERS)('$id against its fake, under chaos', (enricher) => {
  const { matched } = enricher

  it('429 with Retry-After: the request waits what the provider asked, then the job succeeds', async () => {
    const { row, fake, queue } = await boot(enricher)
    const companyId = await seedCompany(matched.name, matched.domain)
    fake.rateLimit(1, '1')

    await send(queue, companyId)
    const runs = await closedRuns(queue, row.id, 1)

    expect(runs.map((r) => [r.status, r.error])).toEqual([['succeeded', null]])
    const first = fake.requests.at(0)
    const second = fake.requests.at(1)
    expect(fake.requests).toHaveLength(2)
    // Retry-After: 1 — the retry is held for the second the provider named.
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(950)
    expect(await valuesOf(companyId)).toMatchObject(matched.values)
  }, 30_000)

  it('429 that persists: the run is rate-limited, re-sent for when the provider said, and succeeds then — no retry spent, no breaker charged', async () => {
    const { row, fake, queue } = await boot(enricher)
    const companyId = await seedCompany(matched.name, matched.domain)
    fake.rateLimit(2, '2')

    await send(queue, companyId)
    const runs = await closedRuns(queue, row.id, 2)

    expect(runs.map((r) => r.status)).toEqual(['failed', 'succeeded'])
    expect(runs.at(0)?.error).toMatch(/^rate-limited: .*answered 429 twice/)
    // The re-sent job ran no earlier than the provider's second Retry-After.
    const retried = fake.requests.at(2)
    const limited = fake.requests.at(1)
    expect((retried?.at ?? 0) - (limited?.at ?? 0)).toBeGreaterThanOrEqual(1950)
    expect(await errorCountOf(row.id)).toBe(0)
    expect(await valuesOf(companyId)).toMatchObject(matched.values)
  }, 30_000)

  it('a key revoked mid-run fails the next job permanently and at once, keeping what was written before', async () => {
    const key = `chaos-${enricher.id}-key-0123456789`
    const { row, fake, queue } = await boot(enricher, key)
    const before = await seedCompany(matched.name, matched.domain)
    const after = await seedCompany('Contoso Labs', 'contoso-labs.example')

    await send(queue, before)
    await closedRuns(queue, row.id, 1)
    fake.revoke(key)
    const sentAt = Date.now()
    await send(queue, after)
    const runs = await closedRuns(queue, row.id, 2)

    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'failed'])
    const refused = runs.at(1)
    expect(refused?.error).toMatch(/^permanent: .*401/)
    expect(refused?.error).toContain('Invalid access credentials.')
    expect(refused?.error).not.toContain(key)
    expect(logged.join('\n')).not.toContain(key)
    // Typed and prompt: one refused request, no waiting on anything.
    expect(Date.now() - sentAt).toBeLessThan(10_000)
    expect(fake.requests.filter((r) => r.key === key)).toHaveLength(2)
    expect(await valuesOf(before)).toMatchObject(matched.values)
    expect(await valuesOf(after)).not.toHaveProperty('description')
    expect((await receiptsFor(row.id)).map((r) => r.entityId)).toEqual([before])
    expect(await errorCountOf(row.id)).toBe(1)
  }, 30_000)

  it('half a failing batch: the succeeding half is written, the failing half retries and wrote nothing', async () => {
    const { row, fake, queue } = await boot(enricher)
    const companies = [
      { name: 'Alder Systems', domain: 'alder-systems.example' },
      { name: 'Birch Analytics', domain: 'birch-analytics.example' },
      { name: 'Cedar Freight', domain: 'cedar-freight.example' },
      { name: 'Dogwood Health', domain: 'dogwood-health.example' },
    ]
    const ids = new Map<string, string>()
    for (const c of companies)
      ids.set(c.domain, await seedCompany(c.name, c.domain))
    const failing = new Set(['cedar-freight.example', 'dogwood-health.example'])
    fake.failWhere(
      (url) => [...failing].some((domain) => enricher.asksAbout(domain)(url)),
      503,
    )

    const jobIds = new Map<string, string>()
    for (const c of companies) {
      const entityId = ids.get(c.domain) ?? ''
      jobIds.set(c.domain, await send(queue, entityId))
    }
    const runs = await closedRuns(queue, row.id, companies.length)

    const byEntity = new Map(runs.map((r) => [r.entityId, r]))
    for (const c of companies) {
      const entityId = ids.get(c.domain) ?? ''
      const run = byEntity.get(entityId)
      const values = await valuesOf(entityId)
      if (failing.has(c.domain)) {
        expect(run?.status).toBe('failed')
        expect(run?.error).toMatch(/^retryable: .*503/)
        expect(values).not.toHaveProperty('description')
        const job = await boss.getJobById(queue, jobIds.get(c.domain) ?? '')
        expect(job?.state).toBe('retry')
      } else {
        expect(run?.status).toBe('succeeded')
        expect(values).toHaveProperty('description')
      }
    }
    expect((await receiptsFor(row.id)).map((r) => r.entityId).sort()).toEqual(
      ['alder-systems.example', 'birch-analytics.example']
        .map((d) => ids.get(d) ?? '')
        .sort(),
    )
  }, 30_000)

  it.todo(
    'a webhook delivered twice produces one set of claims — lands with the webhook ingress and ingress_payload',
  )
})
