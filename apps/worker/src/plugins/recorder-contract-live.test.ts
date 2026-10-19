import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Effect, Exit, Layer } from 'effect'
import { and, desc, eq, isNotNull, like } from 'drizzle-orm'
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
  enrichmentRecord,
  integration,
  interaction,
  jobRun,
} from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { writeIntegrationInteraction } from '@spaces/core/writes/interactions/write'
import {
  INGRESS_SIGNATURE_HEADER,
  receiveWebhookProgram,
  signWebhook,
  webhookSecretProvider,
} from '@spaces/core/writes/ingress/receive'
import { storeCredential } from '@spaces/core/writes/vault'
import { FAKE_GRANOLA_KEY, makeFakeGranolaApi } from '@spaces/sdk/testing'
import type { FakeGranolaApi } from '@spaces/sdk/testing'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { pgBossHost } from '../run-job'
import { REPO_PLUGINS, pluginsRootWith } from './fakes/enrichers'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { meetingLaneLive } from './meetings'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * The recorder contract end to end (D78), on a real pg-boss through `runJob`:
 * Granola's schedule job once per member's key against the fake Granola,
 * and Fathom's and tl;dv's deliveries through the ingress — every recorded
 * note matched by the same writer, deduped on its note id, and a note that
 * leaves the ticked folders removed on the next run. `fetch` itself throws.
 */

const SYNC = 'plugin.granola.sync'
const INGEST = 'plugin.recorder-webhook.ingest'
const SECRET = 'whsec-recorder-0123456789'

let boss: PgBoss

const dropPluginQueues = async () => {
  for (const queue of await boss.getQueues())
    if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
}

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the recorder suite must not reach the network')
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

const runsOf = (queue: string, integrationId: string) =>
  db
    .select({
      status: jobRun.status,
      summary: jobRun.summary,
      error: jobRun.error,
    })
    .from(jobRun)
    .where(
      and(eq(jobRun.queue, queue), eq(jobRun.integrationId, integrationId)),
    )
    .orderBy(desc(jobRun.startedAt))

/** Sends one job and waits out the `job_run` row it closes. */
const runOnce = async (
  queue: string,
  integrationId: string,
  send: () => Promise<unknown>,
) => {
  const before = (await runsOf(queue, integrationId)).length
  await send()
  const closed = await waitFor(
    () => runsOf(queue, integrationId),
    (rows) => rows.length > before && rows.every((r) => r.status !== 'running'),
  )
  const run = closed.at(0)
  if (run === undefined || closed.length === before)
    throw new Error(`${queue} never closed a job_run row`)
  return run
}

/** A meeting the calendar synced, as its lane would have written it. */
const meeting = async (
  uid: string,
  at: number,
  emails: ReadonlyArray<string>,
  calendarEventId?: string,
) => {
  const cal = (
    await db
      .insert(integration)
      .values({ capabilityId: 'google-calendar', version: '0.1.0' })
      .returning({ id: integration.id })
  ).at(0)
  if (!cal) throw new Error('no calendar row')
  const written = await db.transaction((tx) =>
    writeIntegrationInteraction(tx, {
      integrationId: cal.id,
      kind: 'meeting',
      messageId: uid,
      threadId: null,
      subject: uid,
      occurredAt: new Date(at),
      meta: {
        kind: 'meeting',
        ends_at: new Date(at + 30 * 60_000).toISOString(),
        status: 'scheduled',
        conference_url: null,
        organizer: 'anish@fund.example',
        recurring_instance_id: null,
        rsvp: Object.fromEntries(emails.map((e) => [e, 'accepted'])),
        ...(calendarEventId === undefined
          ? {}
          : { calendar_event_id: calendarEventId }),
      },
      body: null,
      edges: [],
    }),
  )
  if (written.kind !== 'written') throw new Error('meeting not written')
  return written.interactionId
}

const recorderEvents = async (interactionId: string) => {
  const meta = (
    await db
      .select({ meta: interaction.meta })
      .from(interaction)
      .where(eq(interaction.id, interactionId))
  ).at(0)?.meta
  return meta?.kind === 'meeting'
    ? (meta.recorder_events ?? []).map((e) => e.provider_event_id)
    : null
}

const callsOf = (integrationId: string) =>
  db
    .select({ id: interaction.id, subject: interaction.subject })
    .from(interaction)
    .where(
      and(
        eq(interaction.kind, 'call'),
        like(interaction.messageId, `rec:${integrationId}:%`),
      ),
    )

const receiptsOf = async (integrationId: string) =>
  (
    await db
      .select({ id: enrichmentRecord.id })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.integrationId, integrationId))
  ).length

// ---------------------------------------------------------------------------
// Granola: a schedule job per member's key
// ---------------------------------------------------------------------------

/** A member's pasted key, ticking `folders`. */
const member = async (key: string, folders: ReadonlyArray<string>) => {
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'granola',
        product: 'notes',
        externalEmail: `${randomUUID().slice(0, 8)}@fund.example`,
        tokensEnc: encryptBundle(
          { type: 'api_key', key },
          { userId: FIXTURE_ACTOR.id, provider: 'granola' },
        ),
        settings: { folder_ids: [...folders] },
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (!row) throw new Error('no connection')
  return row.id
}

const bootGranola = async (api: FakeGranolaApi) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'granola',
        version: '0.1.0',
        enabled: true,
        createdBy: FIXTURE_ACTOR.id,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no integration row')
  const host = makePluginHost({
    enqueue: noEnqueue,
    meetings: meetingLaneLive,
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    fetch: api.fetch,
    sink: () => undefined,
  })
  hosts.push(host)
  const { loaded, verdicts } = await Effect.runPromise(
    reconcilePlugins({
      pluginsRoot: pluginsRootWith('granola', ['granola']),
      only: 'granola',
    }),
  )
  // Installed once by an admin, bound to no member's connection.
  expect(verdicts.map((v) => [v.status, v.reason])).toEqual([['enabled', null]])
  await Effect.runPromise(host.wire(loaded))
  return { row, host }
}

const sync = (integrationId: string) =>
  runOnce(SYNC, integrationId, () => boss.send(SYNC, {}))

const HOUR = 3_600_000

/** Yesterday at `hour` UTC, as the fake's seed lays its notes out. */
const yesterdayAt = (hour: number) => {
  const day = new Date(Date.now() - 24 * HOUR)
  day.setUTCHours(hour, 0, 0, 0)
  return day.getTime()
}

describe('granola, one run per member key', () => {
  it("fetches the ticked folders only, attaches yesterday's two meetings, and removes a note moved out", async () => {
    const api = makeFakeGranolaApi()
    const flent = await meeting(
      `flent-${randomUUID()}`,
      yesterdayAt(10),
      ['maya@flent.example'],
      'gcal-flent-first',
    )
    const acme = await meeting(
      `acme-${randomUUID()}`,
      yesterdayAt(15) + 600_000,
      ['anish@fund.example', 'jane@acme-robotics.example'],
    )
    const connectionId = await member(FAKE_GRANOLA_KEY, [
      'fld_deals',
      'fld_portfolio',
    ])
    const { row, host } = await bootGranola(api)
    expect(host.granted(row.id, 'sync')).toEqual([
      'Content',
      'Http',
      'Log',
      'Secrets',
    ])

    const first = await sync(row.id)
    expect(first).toMatchObject({
      status: 'succeeded',
      summary: '1 of 1 connections synced',
    })
    const key = (note: string) => `rec:${row.id}:${connectionId}:${note}`
    expect(await recorderEvents(flent)).toEqual([key('not_flent_first')])
    expect(await recorderEvents(acme)).toEqual([key('not_acme_board')])
    expect(await callsOf(row.id)).toEqual([])
    // The 1:1 in Personal was never asked for, by folder or by id.
    expect(api.requests.filter((r) => r.url.includes('personal'))).toEqual([])
    expect(api.requests.map((r) => r.query.folder_id ?? r.path).sort()).toEqual(
      ['fld_deals', 'fld_portfolio'],
    )

    // Twice: one row and one set of artifacts.
    await sync(row.id)
    expect(await recorderEvents(flent)).toEqual([key('not_flent_first')])
    expect(await receiptsOf(row.id)).toBe(2)

    // Moved to Personal at Granola: gone on the next run.
    api.move('not_flent_first', ['fld_personal'])
    await sync(row.id)
    expect(await recorderEvents(flent)).toEqual([])
    expect(await recorderEvents(acme)).toEqual([key('not_acme_board')])
    expect(await receiptsOf(row.id)).toBe(1)
  })

  it('a member whose key Granola refuses is marked, and the others still run', async () => {
    const api = makeFakeGranolaApi()
    const good = await member(FAKE_GRANOLA_KEY, ['fld_portfolio'])
    const bad = await member('grn_revoked', ['fld_deals'])
    const { row } = await bootGranola(api)
    const run = await sync(row.id)
    expect(run.status).toBe('succeeded')
    // Every member with an active key in this file runs; only the bad one fails.
    expect(run.summary).toMatch(/^\d+ of \d+ connections synced; /)
    expect(run.summary).toContain(`${bad}: Granola refused the key`)
    expect(run.summary).not.toContain(good)
    const status = async (id: string) =>
      (
        await db
          .select({ status: accountConnection.status })
          .from(accountConnection)
          .where(eq(accountConnection.id, id))
      ).at(0)?.status
    expect(await status(bad)).toBe('error')
    expect(await status(good)).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// Fathom and tl;dv: deliveries through the ingress
// ---------------------------------------------------------------------------

const delivery = (name: string) =>
  readFileSync(
    path.join(REPO_PLUGINS, '_fixtures', 'recorder-webhook', 'fixtures', name),
    'utf8',
  )

const bootWebhook = async () => {
  const secret = await storeCredential({
    scope: 'workspace',
    provider: webhookSecretProvider('recorder-webhook'),
    kind: 'webhook',
    secret: SECRET,
    createdBy: FIXTURE_ACTOR.id,
  })
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'recorder-webhook',
        version: '0.1.0',
        enabled: true,
        webhookCredentialId: secret.id,
        createdBy: FIXTURE_ACTOR.id,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  const host = makePluginHost({
    enqueue: noEnqueue,
    meetings: meetingLaneLive,
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    sink: () => undefined,
  })
  hosts.push(host)
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({
      pluginsRoot: pluginsRootWith('recorder', ['_fixtures/recorder-webhook']),
      only: 'recorder-webhook',
    }),
  )
  await Effect.runPromise(host.wire(loaded))
  return row
}

/** Web's side: verify, store, enqueue onto pg-boss; then the job's run. */
const deliver = (integrationId: string, body: string) =>
  runOnce(INGEST, integrationId, async () => {
    const bytes = new TextEncoder().encode(body)
    const exit = await Effect.runPromiseExit(
      receiveWebhookProgram({
        integrationId,
        headers: { [INGRESS_SIGNATURE_HEADER]: signWebhook(SECRET, bytes) },
        body: bytes,
      }).pipe(
        Effect.provide(
          Enqueue.fromSender({
            enqueue: (queue, data) => boss.send(queue, data),
          }),
        ),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

describe('webhook recorders, through the ingress', () => {
  it('a Fathom delivery attaches by time and attendees; a tl;dv one births a call; replays double nothing', async () => {
    const ohmium = await meeting(
      `ohmium-${randomUUID()}`,
      Date.parse('2026-10-08T10:00:00Z'),
      ['anish@fund.example', 'priya@ohmium-live.example'],
    )
    const row = await bootWebhook()

    const fathom = delivery('fathom.json')
    expect(await deliver(row.id, fathom)).toMatchObject({ status: 'succeeded' })
    const key = `rec:${row.id}:workspace:fathom:88213`
    expect(await recorderEvents(ohmium)).toEqual([key])

    const tldv = delivery('tldv.json')
    expect(await deliver(row.id, tldv)).toMatchObject({ status: 'succeeded' })
    expect(await callsOf(row.id)).toEqual([
      { id: expect.any(String), subject: 'Coffee with a founder' },
    ])

    await deliver(row.id, fathom)
    await deliver(row.id, tldv)
    expect(await recorderEvents(ohmium)).toEqual([key])
    expect(await callsOf(row.id)).toHaveLength(1)
    expect(await receiptsOf(row.id)).toBe(2)
  })
})
