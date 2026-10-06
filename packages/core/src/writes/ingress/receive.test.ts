import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { ingressPayload, integration } from '@spaces/db/schema'
import type { IntegrationManifest } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { Enqueue } from '../../queue/enqueue'
import { storeCredential } from '../vault/index'
import { pruneIngressPayloadsProgram } from './prune'
import {
  INGRESS_SIGNATURE_HEADER,
  payloadOf,
  receiveWebhookProgram,
  signWebhook,
  verifySignature,
  webhookSecretProvider,
} from './receive'
import type { Delivery } from './receive'

/**
 * The ingress program without HTTP: the row decides, the vault's secret
 * checks the signature, the raw body is stored, and each webhook job's queue
 * is handed `{ payload, receivedAt }` through a recording `Enqueue`.
 */

const SECRET = 'whsec-fixture-0123456789'

const manifestFor = (
  signature: 'hmac-sha256' | 'none',
  withIngress = true,
): IntegrationManifest => ({
  manifestVersion: 1,
  id: 'hooked',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Hooked',
  description: 'A webhook fixture.',
  settings: {},
  jobs: withIngress
    ? { ingest: { trigger: 'webhook', uses: ['Content', 'Log'] } }
    : { echo: { trigger: 'action', uses: ['Log'] } },
  ...(withIngress ? { ingress: { signature } } : {}),
})

let sent: Array<{ queue: string; data: Record<string, unknown> }> = []
let accept = true
const Recording = Layer.succeed(
  Enqueue,
  Enqueue.of({
    enqueue: (queue, data) =>
      Effect.sync(() => {
        if (!accept) return null
        sent.push({ queue, data })
        return randomUUID()
      }),
  }),
)

beforeEach(async () => {
  sent = []
  accept = true
  await db.execute(sql`truncate ingress_payload, integration cascade`)
})

const install = async (
  overrides: Partial<typeof integration.$inferInsert> = {},
  signature: 'hmac-sha256' | 'none' = 'hmac-sha256',
) => {
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
        status: 'enabled',
        manifest: manifestFor(signature),
        webhookCredentialId: secret.id,
        ...overrides,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const body = new TextEncoder().encode(
  JSON.stringify({ entityId: randomUUID(), title: 'Call with Northwind' }),
)

const deliver = (delivery: Delivery) =>
  Effect.runPromiseExit(
    receiveWebhookProgram(delivery).pipe(Effect.provide(Recording)),
  )

const tagOf = (exit: Exit.Exit<unknown, { _tag: string }>) =>
  Exit.isFailure(exit)
    ? (Option.getOrNull(Cause.findErrorOption(exit.cause))?._tag ?? 'defect')
    : 'ok'

const stored = () => db.select().from(ingressPayload)

const signed = (integrationId: string, bytes = body): Delivery => ({
  integrationId,
  headers: {
    'content-type': 'application/json',
    [INGRESS_SIGNATURE_HEADER]: signWebhook(SECRET, bytes),
    cookie: 'session=abc',
  },
  body: bytes,
})

describe('a signed delivery', () => {
  it('is stored raw and enqueued on plugin.<id>.<webhook job> as { payload, receivedAt }', async () => {
    const row = await install()
    const exit = await deliver(signed(row.id))
    expect(tagOf(exit)).toBe('ok')
    const rows = await stored()
    expect(rows).toHaveLength(1)
    expect(rows.at(0)?.integrationId).toBe(row.id)
    expect(Buffer.compare(rows.at(0)?.body ?? Buffer.alloc(0), body)).toBe(0)
    expect(rows.at(0)?.headers).toMatchObject({
      'content-type': 'application/json',
    })
    expect(rows.at(0)?.headers).not.toHaveProperty('cookie')
    expect(sent).toEqual([
      {
        queue: 'plugin.hooked.ingest',
        data: {
          payload: JSON.parse(new TextDecoder().decode(body)),
          receivedAt: rows.at(0)?.receivedAt.toISOString(),
        },
      },
    ])
  })

  it('a manifest declaring no signature needs no header', async () => {
    const row = await install({}, 'none')
    const exit = await deliver({ integrationId: row.id, headers: {}, body })
    expect(tagOf(exit)).toBe('ok')
    expect(sent).toHaveLength(1)
  })

  it('stored but not queued answers IngressNotQueued', async () => {
    const row = await install()
    accept = false
    expect(tagOf(await deliver(signed(row.id)))).toBe('IngressNotQueued')
  })
})

describe('refused before anything is stored', () => {
  it('a flipped byte, a missing header, or no secret saved is unauthorized', async () => {
    const row = await install()
    const good = signWebhook(SECRET, body)
    const flipped = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`
    const wrong = await deliver({
      integrationId: row.id,
      headers: { [INGRESS_SIGNATURE_HEADER]: flipped },
      body,
    })
    expect(tagOf(wrong)).toBe('IngressUnauthorized')
    const missing = await deliver({ integrationId: row.id, headers: {}, body })
    expect(tagOf(missing)).toBe('IngressUnauthorized')
    await db
      .update(integration)
      .set({ webhookCredentialId: null })
      .where(eq(integration.id, row.id))
    expect(tagOf(await deliver(signed(row.id)))).toBe('IngressUnauthorized')
    expect(await stored()).toEqual([])
    expect(sent).toEqual([])
  })

  it('disabled, degraded, tripped, removed, installing, no ingress and unknown all read as one not found', async () => {
    const cases: Array<Partial<typeof integration.$inferInsert>> = [
      { enabled: false },
      { status: 'degraded' },
      { status: 'disabled' },
      { status: 'installing' },
      { removedAt: new Date() },
      { manifest: manifestFor('hmac-sha256', false) },
      { manifest: null },
    ]
    for (const overrides of cases) {
      await db.execute(sql`truncate integration cascade`)
      const row = await install(overrides)
      expect(tagOf(await deliver(signed(row.id)))).toBe('IngressNotFound')
    }
    expect(tagOf(await deliver(signed(randomUUID())))).toBe('IngressNotFound')
    expect(tagOf(await deliver(signed('not-a-uuid')))).toBe('IngressNotFound')
    expect(await stored()).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('the signature check', () => {
  it('accepts sha256=<hex> and bare hex, and refuses anything malformed', () => {
    const header = signWebhook(SECRET, body)
    expect(verifySignature(SECRET, body, header)).toBe(true)
    expect(verifySignature(SECRET, body, header.slice('sha256='.length))).toBe(
      true,
    )
    expect(verifySignature('another-secret', body, header)).toBe(false)
    expect(verifySignature(SECRET, body, undefined)).toBe(false)
    expect(verifySignature(SECRET, body, 'sha256=zz')).toBe(false)
    expect(verifySignature(SECRET, body, `${header}00`)).toBe(false)
  })

  it('hands a non-JSON body to the job as its text', () => {
    expect(payloadOf(new TextEncoder().encode('plain words'))).toBe(
      'plain words',
    )
  })
})

describe('retention', () => {
  it('deletes deliveries older than the retention and keeps the rest', async () => {
    const row = await install()
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await db.insert(ingressPayload).values([
      {
        integrationId: row.id,
        receivedAt: old,
        headers: {},
        body: Buffer.from(body),
      },
      { integrationId: row.id, headers: {}, body: Buffer.from(body) },
    ])
    const { deleted } = await Effect.runPromise(pruneIngressPayloadsProgram(7))
    expect(deleted).toBe(1)
    const left = await stored()
    expect(left).toHaveLength(1)
    expect(left.at(0)?.receivedAt.getTime()).toBeGreaterThan(old.getTime())
  })
})
