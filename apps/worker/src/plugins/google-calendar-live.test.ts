import { randomUUID } from 'node:crypto'
import { Effect, Layer } from 'effect'
import { and, count, desc, eq, isNotNull } from 'drizzle-orm'
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
  accountConnection,
  entityAlias,
  integration,
  interaction,
  interactionEntity,
  jobRun,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { FAKE_CALENDAR_OWNER } from '@spaces/sdk/testing'
import type { FakeCalendarApi } from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pgBossHost } from '../run-job'
import { pluginsRootWith } from './fakes/enrichers'
import { cassetteProviders } from './fakes/registry'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { meetingLaneLive } from './meetings'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * Google Calendar under `SPACES_FAKE_PROVIDERS=1`, end to end: the real
 * bundle loaded as boot loads it, its `sync` queue worked by a real pg-boss
 * through `runJob`, the fake calendar standing in for Google and the
 * meeting lane writing the test database. `fetch` itself throws, so nothing
 * reaches a network. The fake's demo calendar holds five-year-old board
 * meetings, last week's intro, this week's meetings, an internal standup
 * and a pitch the owner declined; the connection was made an hour ago.
 */

const QUEUE = 'plugin.google-calendar.sync'
const HOUR = 3_600_000

let boss: PgBoss

const dropPluginQueues = async () => {
  for (const queue of await boss.getQueues())
    if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
}

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the calendar suite must not reach the network')
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

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  await dropPluginQueues()
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

afterAll(async () => {
  await boss.stop({ graceful: false })
  vi.unstubAllGlobals()
})

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

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

/** The owner's connection, made `connectedAt`, and the row bound to it. */
const connect = async (connectedAt: Date) => {
  const members = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, FAKE_CALENDAR_OWNER))
  if (members.length === 0)
    await db.insert(user).values({
      id: `member-${randomUUID().slice(0, 8)}`,
      name: 'Anish',
      email: FAKE_CALENDAR_OWNER,
      emailVerified: true,
    })
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'calendar',
        externalEmail: `${randomUUID().slice(0, 8)}@fund.example`,
        // Never read: the fake's stand-in hands out the access token.
        tokensEnc: Buffer.from('fake'),
        scopes: ['openid', 'email', 'calendar.events.readonly'],
        createdAt: connectedAt,
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!connection) throw new Error('no connection')
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'google-calendar',
        version: '0.1.0',
        enabled: true,
        connectionId: connection.id,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row
}

const boot = async () => {
  const connectedAt = new Date(Date.now() - HOUR)
  const row = await connect(connectedAt)
  const fakes = cassetteProviders()
  const api = fakes.calendar('google-calendar')
  if (api === null) throw new Error('no fake calendar')
  const host = makePluginHost({
    enqueue: noEnqueue,
    meetings: meetingLaneLive,
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    fakes,
  })
  hosts.push(host)
  const { loaded, verdicts } = await Effect.runPromise(
    reconcilePlugins({
      pluginsRoot: pluginsRootWith('calendar', ['google-calendar']),
      only: 'google-calendar',
      fakes,
    }),
  )
  expect(verdicts.map((v) => [v.status, v.reason])).toEqual([['enabled', null]])
  await Effect.runPromise(host.wire(loaded))
  return { row, api, host, connectedAt }
}

/** One tick of the schedule, waited out until its `job_run` row closes. */
const tick = async (integrationId: string) => {
  const before = await runs(integrationId)
  const id = await boss.send(QUEUE, {})
  if (id === null) throw new Error('the queue refused the tick')
  const closed = await waitFor(
    () => runs(integrationId),
    (rows) =>
      rows.length > before.length && rows.every((r) => r.status !== 'running'),
  )
  const run = closed.at(0)
  if (run === undefined || closed.length === before.length)
    throw new Error('the tick never closed a job_run row')
  return run
}

const runs = (integrationId: string) =>
  db
    .select({
      status: jobRun.status,
      summary: jobRun.summary,
      error: jobRun.error,
    })
    .from(jobRun)
    .where(
      and(eq(jobRun.queue, QUEUE), eq(jobRun.integrationId, integrationId)),
    )
    .orderBy(desc(jobRun.startedAt))

const cursorOf = async (integrationId: string) =>
  (
    await db
      .select({ cursors: integration.cursors })
      .from(integration)
      .where(eq(integration.id, integrationId))
  ).at(0)?.cursors ?? null

const interactions = async () =>
  (await db.select({ n: count() }).from(interaction)).at(0)?.n ?? 0

const meetingOf = async (uid: string) =>
  (
    await db.select().from(interaction).where(eq(interaction.messageId, uid))
  ).at(0) ?? null

const lastList = (api: FakeCalendarApi) => api.requests.at(-1)?.query ?? {}

describe('google-calendar with the fakes on', () => {
  it('syncs forward-only, keeps the external meetings, and recovers from an expired token without re-importing history', async () => {
    const { row, api, host, connectedAt } = await boot()

    // A syncer's Layer: no Facts, no Identity, no Ai.
    expect(host.granted(row.id, 'sync')).toEqual([
      'Content',
      'Http',
      'Log',
      'Secrets',
    ])

    const first = await tick(row.id)
    expect(first).toMatchObject({ status: 'succeeded' })
    expect(first.summary).toMatch(/^nextCursor sync-1-/)
    expect(api.requests.at(0)?.query).toMatchObject({
      timeMin: connectedAt.toISOString(),
      singleEvents: 'true',
      showDeleted: 'true',
    })
    // This week's two external meetings, and nothing else: the five-year-old
    // board meetings and last week's intro were never fetched, the standup is
    // internal and the Delta pitch was declined.
    expect(await interactions()).toBe(2)
    for (const uid of [
      'board-2021@google.com',
      'board-2021b@google.com',
      'intro-last-week@google.com',
      'standup@google.com',
      'declined-pitch@google.com',
    ])
      expect(await meetingOf(uid)).toBeNull()

    const acme = await meetingOf('acme-catchup@google.com')
    expect(acme).toMatchObject({
      kind: 'meeting',
      sourceClass: 'integration',
      sourceRef: row.id,
      meta: { status: 'scheduled', calendar_event_id: 'acme-catchup' },
    })
    const edged = await db
      .select({ kind: entityAlias.kind, value: entityAlias.valueNorm })
      .from(interactionEntity)
      .innerJoin(
        entityAlias,
        eq(entityAlias.entityId, interactionEntity.entityId),
      )
      .where(eq(interactionEntity.interactionId, acme?.id ?? ''))
    expect(edged).toEqual(
      expect.arrayContaining([
        { kind: 'email', value: 'jane@acme-robotics.example' },
        { kind: 'domain', value: 'acme-robotics.example' },
      ]),
    )

    // The token expires at the fake: a typed outcome, the cursor cleared.
    api.expireSyncTokens()
    const expired = await tick(row.id)
    expect(expired).toMatchObject({
      status: 'succeeded',
      summary: 'cursor invalid, cleared: Google expired the sync token',
    })
    expect(await cursorOf(row.id)).toEqual({ sync: null })

    // The next run is the bounded re-sync: from the connection, never earlier.
    const resynced = await tick(row.id)
    expect(resynced.summary).toMatch(/^nextCursor sync-2-/)
    expect(lastList(api)).toMatchObject({ timeMin: connectedAt.toISOString() })
    expect(lastList(api).syncToken).toBeUndefined()
    expect(await interactions()).toBe(2)
  })

  it('follows a cancellation in place and survives a 429 and a revoked token', async () => {
    const { row, api } = await boot()
    await tick(row.id)
    const held = await meetingOf('acme-catchup@google.com')

    // Google sends the deleted event as its id alone.
    api.cancel('acme-catchup', { minimal: true })
    api.rateLimit(1, 1)
    const cancelled = await tick(row.id)
    expect(cancelled).toMatchObject({ status: 'succeeded' })
    expect(await meetingOf('acme-catchup@google.com')).toMatchObject({
      id: held?.id,
      meta: { status: 'cancelled' },
    })
    expect(await interactions()).toBe(2)

    // A second tick does not resurrect it.
    await tick(row.id)
    expect(await meetingOf('acme-catchup@google.com')).toMatchObject({
      meta: { status: 'cancelled' },
    })

    // The grant is revoked: the run fails at once, in words, and keeps no token.
    api.revoke()
    const refused = await tick(row.id)
    expect(refused).toMatchObject({ status: 'failed' })
    expect(refused.error).toContain(
      'Google refused the calendar connection: reconnect it',
    )
    expect(await interactions()).toBe(2)
  })
})
