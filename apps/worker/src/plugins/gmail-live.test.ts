import { readFileSync } from 'node:fs'
import path from 'node:path'
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
  document,
  entityAlias,
  integration,
  interaction,
  interactionEntity,
  jobRun,
  note,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { z } from 'zod'
import { DEFAULT_MAIL_EXCLUDE } from '#web/lib/arrival/noise'
import { FAKE_GMAIL_OWNER } from '@spaces/sdk/testing'
import type { FakeGmailApi } from '@spaces/sdk/testing'
import { truncateAndReseed } from '#web/test/reseed'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pgBossHost } from '../run-job'
import { REPO_PLUGINS, pluginsRootWith } from './fakes/enrichers'
import { cassetteProviders } from './fakes/registry'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { mailLaneLive } from './mail'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * Gmail under `SPACES_FAKE_PROVIDERS=1`, end to end: the real bundle loaded
 * as boot loads it, its `sync` queue worked by a real pg-boss through
 * `runJob`, the fake Gmail standing in for Google and the mail lane writing
 * the test database. `fetch` itself throws, so nothing reaches a network.
 * The fake's demo mailbox holds a year of mail before the connection, made
 * an hour ago, and the last half hour's.
 */

const QUEUE = 'plugin.gmail.sync'
const HOUR = 3_600_000

let boss: PgBoss

const dropPluginQueues = async () => {
  for (const queue of await boss.getQueues())
    if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
}

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the gmail suite must not reach the network')
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

/** The owner's Gmail connection, made `connectedAt`, and the row bound to it. */
const connect = async (connectedAt: Date) => {
  const connection = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'gmail',
        externalEmail: FAKE_GMAIL_OWNER,
        // Never read: the fake's stand-in hands out the access token.
        tokensEnc: Buffer.from('fake'),
        scopes: ['openid', 'email', 'gmail.readonly'],
        createdAt: connectedAt,
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!connection) throw new Error('no connection')
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'gmail',
        version: '0.1.0',
        enabled: true,
        connectionId: connection.id,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no integration row')
  return { row, connectionId: connection.id }
}

const boot = async () => {
  // Each case starts from an empty workspace: the mailbox is one connection.
  await truncateAndReseed()
  const connectedAt = new Date(Date.now() - HOUR)
  const { row, connectionId } = await connect(connectedAt)
  const fakes = cassetteProviders()
  const api: FakeGmailApi | null = fakes.gmail('gmail')
  if (api === null) throw new Error('no fake mailbox')
  const host = makePluginHost({
    enqueue: noEnqueue,
    mail: mailLaneLive,
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    fakes,
  })
  hosts.push(host)
  const { loaded, verdicts } = await Effect.runPromise(
    reconcilePlugins({
      pluginsRoot: pluginsRootWith('gmail', ['gmail']),
      only: 'gmail',
      fakes,
    }),
  )
  expect(verdicts.map((v) => [v.status, v.reason])).toEqual([['enabled', null]])
  await Effect.runPromise(host.wire(loaded))
  return { row, connectionId, api, host, connectedAt }
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

const emailOf = async (messageId: string) =>
  (
    await db
      .select()
      .from(interaction)
      .where(eq(interaction.messageId, messageId))
  ).at(0) ?? null

const lists = (api: FakeGmailApi) =>
  api.requests.filter((r) => r.path === '/users/me/messages')

describe('gmail with the fakes on', () => {
  it('syncs forward-only, files what is not noise privately to the owner, and recovers from an expired history id without re-importing history', async () => {
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
    expect(first.summary).toBe(`nextCursor ${api.historyId()}`)
    // The cursor is the mailbox's history id; the list from the connection.
    expect(api.requests.at(0)?.path).toBe('/users/me/profile')
    expect(lists(api).at(0)?.query.q).toBe(
      `after:${Math.floor(connectedAt.getTime() / 1000)}`,
    )

    // Acme's update, Gamma's intro and the owner's reply; the promotion, the
    // noreply@ receipt and the newsletter are refused, and the year of mail
    // before the connection was never listed.
    expect(await interactions()).toBe(3)
    for (const id of [
      'board-2025@acme-robotics.example',
      'intro@betalabs.example',
      'gamma-old@gamma.example',
      'before-connect@acme-robotics.example',
      'sale@shopstuff.example',
      'receipt@saas.example',
      'issue-42@newsletter.example',
    ])
      expect(await emailOf(id)).toBeNull()

    const acme = await emailOf('acme-q3@acme-robotics.example')
    expect(acme).toMatchObject({
      kind: 'email',
      sourceClass: 'integration',
      sourceRef: row.id,
      meta: { kind: 'email', from: 'jane@acme-robotics.example' },
    })
    expect(
      (
        await db
          .select({ visibility: note.visibility, authorId: note.authorId })
          .from(note)
          .where(eq(note.entityId, acme?.noteId ?? ''))
      ).at(0),
    ).toEqual({ visibility: 'private', authorId: FIXTURE_ACTOR.id })
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
    expect(
      await db
        .select({ sourceRef: document.sourceRef })
        .from(document)
        .where(eq(document.filename, 'acme-q3.pdf')),
    ).toEqual([{ sourceRef: row.id }])

    // New mail arrives: the history feed brings exactly it.
    api.deliver({
      id: 'm-later',
      labelIds: ['INBOX'],
      receivedAt: Date.now(),
      messageId: 'later@gamma.example',
      from: 'Lee Gamma <lee@gamma.example>',
      to: [FAKE_GMAIL_OWNER],
      subject: 'Gamma — following up',
      body: 'Any thoughts?',
    })
    const later = await tick(row.id)
    expect(later.summary).toBe(`nextCursor ${api.historyId()}`)
    expect(await interactions()).toBe(4)

    // Gmail expires the history id: a typed outcome, the cursor cleared.
    api.expireHistory()
    const expired = await tick(row.id)
    expect(expired).toMatchObject({
      status: 'succeeded',
      summary: 'cursor invalid, cleared: Gmail no longer holds that history id',
    })
    expect(await cursorOf(row.id)).toEqual({ sync: null })

    // The next run takes the mailbox's history id again and lists from the
    // connection, never the whole mailbox; the Message-ID dedupes.
    const listed = lists(api).length
    const rederived = await tick(row.id)
    expect(rederived.summary).toBe(`nextCursor ${api.historyId()}`)
    const again = lists(api).slice(listed)
    expect(again.length).toBeGreaterThan(0)
    expect(again.every((r) => r.query.q?.startsWith('after:'))).toBe(true)
    expect(await interactions()).toBe(4)
  }, 60_000)

  it('waits out a 429, and marks the connection in error on a refused grant without retrying', async () => {
    const { row, api, connectionId } = await boot()
    api.rateLimit(1, 1)
    const limited = await waitFor(
      () => tick(row.id),
      (run) => run.status === 'succeeded',
      30_000,
    )
    expect(limited).toMatchObject({ status: 'succeeded' })
    expect(await interactions()).toBe(3)

    api.revoke()
    const refused = await tick(row.id)
    expect(refused).toMatchObject({ status: 'failed' })
    const reason =
      'Google refused the Gmail connection (Invalid Credentials): reconnect it'
    expect(refused.error).toContain(reason)
    expect(
      (
        await db
          .select({
            status: accountConnection.status,
            errorReason: accountConnection.errorReason,
          })
          .from(accountConnection)
          .where(eq(accountConnection.id, connectionId))
      ).at(0),
    ).toEqual({ status: 'error', errorReason: reason })
    // Never retried: no second run follows the refusal.
    const count = (await runs(row.id)).length
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(await runs(row.id)).toHaveLength(count)
  }, 60_000)

  it('ships the host’s default blocklist as its settings’ defaults', () => {
    const manifest = z
      .object({
        settings: z.object({
          properties: z.object({
            shareBodies: z.object({ default: z.literal(false) }),
            excludeSenders: z.object({ default: z.array(z.string()) }),
            excludeLabels: z.object({ default: z.array(z.string()) }),
          }),
        }),
      })
      .parse(
        JSON.parse(
          readFileSync(
            path.join(REPO_PLUGINS, 'gmail', 'dist', 'manifest.json'),
            'utf8',
          ),
        ),
      )
    expect(manifest.settings.properties.excludeSenders.default).toEqual([
      ...DEFAULT_MAIL_EXCLUDE.senders,
    ])
    expect(manifest.settings.properties.excludeLabels.default).toEqual([
      ...DEFAULT_MAIL_EXCLUDE.labels,
    ])
  })
})
