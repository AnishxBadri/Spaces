import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Option } from 'effect'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { ingressPayload, integration, jobRun, signal } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  INGRESS_SIGNATURE_HEADER,
  receiveWebhookProgram,
  signWebhook,
  webhookSecretProvider,
} from '@spaces/core/writes/ingress/receive'
import { storeCredential } from '@spaces/core/writes/vault'
import { pgBossHost } from '../run-job'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'

/**
 * Webhook ingress end to end, without HTTP: core's verify → store → enqueue
 * program sends onto a real pg-boss, the worker has the hooked fixture
 * loaded and its `plugin.hooked.ingest` queue registered, and `runJob` runs
 * the job — so the delivery leaves an `ingress_payload` row, a `job_run`
 * naming the integration, and the signal the plugin claimed.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const QUEUE = 'plugin.hooked.ingest'
const SECRET = 'whsec-live-0123456789'

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

const hosts: Array<PluginHost> = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

/** The hooked fixture's dist as `<root>/hooked/current/`, its row with a saved secret, loaded and wired. */
const installHooked = async () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-ingress-')),
    'plugins',
  )
  const dir = path.join(root, 'hooked', 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(path.join(fixtures, 'hooked', 'dist', file), path.join(dir, file))
  const secret = await storeCredential({
    scope: 'workspace',
    provider: webhookSecretProvider('hooked'),
    kind: 'webhook',
    secret: SECRET,
    createdBy: FIXTURE_ACTOR.id,
  })
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'hooked',
        version: '0.1.0',
        enabled: true,
        webhookCredentialId: secret.id,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  const { loaded } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root }),
  )
  const host = makePluginHost({
    enqueue: Enqueue.fromSender({ enqueue: () => Promise.resolve(null) }),
    queues: { boss, host: pgBossHost(boss), pollingIntervalSeconds: 0.5 },
    sink: () => undefined,
  })
  hosts.push(host)
  const wired = await Effect.runPromise(host.wire(loaded))
  expect(wired.map((v) => v.line)).toEqual(['[plugins] hooked: wired ingest'])
  return row
}

/** Web's side, with pg-boss as the queue it sends onto. */
const deliver = (integrationId: string, body: string, signature: string) =>
  Effect.runPromiseExit(
    receiveWebhookProgram({
      integrationId,
      headers: { [INGRESS_SIGNATURE_HEADER]: signature },
      body: new TextEncoder().encode(body),
    }).pipe(
      Effect.provide(
        Enqueue.fromSender({
          enqueue: (queue, data) => boss.send(queue, data),
        }),
      ),
    ),
  )

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

const runsOf = (integrationId: string) =>
  db
    .select()
    .from(jobRun)
    .where(
      and(eq(jobRun.queue, QUEUE), eq(jobRun.integrationId, integrationId)),
    )

const queued = async () =>
  (
    await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${QUEUE}`,
    )
  ).rows.at(0)?.n ?? -1

describe('a webhook delivery, end to end', () => {
  it('a signed delivery is stored, runs as a job_run on plugin.hooked.ingest, and its signal lands', async () => {
    const row = await installHooked()
    const companyId = (
      await resolveEntity({
        kind: 'company',
        name: 'Northwind Robotics',
        keys: { domain: 'northwind-robotics.example' },
        source: { class: 'manual' },
      })
    ).entityId
    const body = JSON.stringify({
      entityId: companyId,
      title: 'Intro call with Northwind',
    })
    const bytes = new TextEncoder().encode(body)

    const exit = await deliver(row.id, body, signWebhook(SECRET, bytes))
    expect(exit).toEqual(
      Exit.succeed({ payloadId: expect.any(String), queues: [QUEUE] }),
    )
    const stored = await db
      .select()
      .from(ingressPayload)
      .where(eq(ingressPayload.integrationId, row.id))
    expect(stored.map((s) => s.body.toString('utf8'))).toEqual([body])

    const runs = await waitFor(
      () => runsOf(row.id),
      (r) => r.length > 0 && r.every((x) => x.status !== 'running'),
    )
    expect(runs).toHaveLength(1)
    expect(runs.at(0)).toMatchObject({ status: 'succeeded', attempt: 1 })

    const signals = await db
      .select()
      .from(signal)
      .where(eq(signal.sourceRef, row.id))
    expect(signals).toHaveLength(1)
    expect(signals.at(0)).toMatchObject({
      entityId: companyId,
      sourceClass: 'integration',
      sourceRef: row.id,
    })
    expect(signals.at(0)?.payload).toMatchObject({
      kind: 'call',
      title: 'Intro call with Northwind',
    })
  })

  it('a wrong signature enqueues nothing and stores nothing', async () => {
    const row = await installHooked()
    const before = await queued()
    const exit = await deliver(
      row.id,
      '{"entityId":"x","title":"y"}',
      signWebhook('not-the-secret', new Uint8Array(0)),
    )
    const error = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.findErrorOption(exit.cause))
      : null
    expect(error?._tag).toBe('IngressUnauthorized')
    expect(await queued()).toBe(before)
    expect(
      await db
        .select()
        .from(ingressPayload)
        .where(eq(ingressPayload.integrationId, row.id)),
    ).toEqual([])
  })
})
