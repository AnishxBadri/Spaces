import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { ingressPayload, integration } from '@spaces/db/schema'
import type { IntegrationManifest } from '@spaces/db/schema'
import {
  INGRESS_MAX_BYTES,
  INGRESS_SIGNATURE_HEADER,
  signWebhook,
  webhookSecretProvider,
} from '@spaces/core/writes/ingress/receive'
import { storeCredential } from '@spaces/core/writes/vault'
import { enqueued } from '#/test/queue-stub'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { handleWebhook } from './ingress'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * `/api/webhooks/$id` as Request → Response, on the real database and vault
 * with the queue stubbed: what each delivery is answered, what is stored,
 * and what is enqueued.
 */

const SECRET = 'whsec-route-0123456789'

const HOOKED: IntegrationManifest = {
  manifestVersion: 1,
  id: 'hooked',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Hooked',
  description: 'A webhook fixture.',
  settings: {},
  jobs: { ingest: { trigger: 'webhook', uses: ['Content', 'Log'] } },
  ingress: { signature: 'hmac-sha256' },
}

beforeEach(async () => {
  enqueued.length = 0
  await db.execute(sql`truncate ingress_payload, integration cascade`)
})

const install = async (overrides: Partial<typeof integration.$inferInsert>) => {
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
        manifest: HOOKED,
        webhookCredentialId: secret.id,
        ...overrides,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  return row
}

const BODY = JSON.stringify({ entityId: randomUUID(), title: 'Call' })

const post = (
  id: string,
  body: BodyInit,
  headers: Record<string, string> = {},
) =>
  handleWebhook(
    new Request(`http://localhost:3000/api/webhooks/${id}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
      // A stream body needs half-duplex in Node's fetch.
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    }),
    id,
  )

const signedHeaders = (body: string) => ({
  [INGRESS_SIGNATURE_HEADER]: signWebhook(
    SECRET,
    new TextEncoder().encode(body),
  ),
})

const stored = () => db.select().from(ingressPayload)

describe('POST /api/webhooks/$id', () => {
  it('a signed delivery answers 200, stores the raw body and enqueues plugin.hooked.ingest — in under 50ms warm', async () => {
    const row = await install({})
    const first = await post(row.id, BODY, signedHeaders(BODY))
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ received: true })
    const rows = await stored()
    expect(rows).toHaveLength(1)
    expect(rows.at(0)?.body.toString('utf8')).toBe(BODY)
    expect(enqueued).toEqual([
      {
        name: 'plugin.hooked.ingest',
        data: {
          payload: JSON.parse(BODY),
          receivedAt: rows.at(0)?.receivedAt.toISOString(),
        },
      },
    ])

    const timings: Array<number> = []
    for (let i = 0; i < 5; i++) {
      const started = performance.now()
      const response = await post(row.id, BODY, signedHeaders(BODY))
      timings.push(performance.now() - started)
      expect(response.status).toBe(200)
    }
    expect(Math.min(...timings)).toBeLessThan(50)
  })

  it('a flipped signature byte or a missing header answers 401 and enqueues nothing', async () => {
    const row = await install({})
    const good = signedHeaders(BODY)[INGRESS_SIGNATURE_HEADER]
    const flipped = `${good.slice(0, -1)}${good.endsWith('a') ? 'b' : 'a'}`
    const wrong = await post(row.id, BODY, {
      [INGRESS_SIGNATURE_HEADER]: flipped,
    })
    expect(wrong.status).toBe(401)
    const missing = await post(row.id, BODY)
    expect(missing.status).toBe(401)
    expect(await stored()).toEqual([])
    expect(enqueued).toEqual([])
  })

  it('disabled, degraded, removed and unknown all answer the same 404', async () => {
    const answers: Array<[number, string]> = []
    for (const overrides of [
      { enabled: false },
      { status: 'degraded' as const },
      { removedAt: new Date() },
    ]) {
      await db.execute(sql`truncate integration cascade`)
      const row = await install(overrides)
      const r = await post(row.id, BODY, signedHeaders(BODY))
      answers.push([r.status, await r.text()])
    }
    const unknown = await post(randomUUID(), BODY, signedHeaders(BODY))
    answers.push([unknown.status, await unknown.text()])
    const garbage = await post('../../etc', BODY, signedHeaders(BODY))
    answers.push([garbage.status, await garbage.text()])
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(
      new Set([JSON.stringify([404, 'Not found'])]),
    )
    expect(await stored()).toEqual([])
    expect(enqueued).toEqual([])
  })

  it('a body over the limit answers 413 before anything is stored, whether Content-Length says so or not', async () => {
    const row = await install({})
    const big = 'x'.repeat(INGRESS_MAX_BYTES + 1)
    const declared = await post(row.id, big, signedHeaders(big))
    expect(declared.status).toBe(413)
    const chunk = new Uint8Array(64 * 1024)
    let sent = 0
    const undeclared = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > INGRESS_MAX_BYTES) controller.close()
        else {
          sent += chunk.byteLength
          controller.enqueue(chunk)
        }
      },
    })
    const streamed = await post(row.id, undeclared, {
      [INGRESS_SIGNATURE_HEADER]: 'sha256=00',
    })
    expect(streamed.status).toBe(413)
    expect(await stored()).toEqual([])
    expect(enqueued).toEqual([])
  })
})
