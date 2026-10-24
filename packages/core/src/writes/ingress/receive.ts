import { createHmac, timingSafeEqual } from 'node:crypto'
import { Clock, Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { ingressPayload, integration } from '@spaces/db/schema'
import type { IngressHeaders } from '@spaces/db/schema'
import { manifestSchema } from '@spaces/sdk'
import type { Json } from '../../json'
import { jsonValue } from '../../json'
import { Enqueue } from '../../queue/enqueue'
import { pluginQueueName } from '../../queue/names'
import type { PluginQueueName } from '../../queue/names'
import { resolveSecretById } from '../vault'

/**
 * Webhook ingress: verify, store raw, enqueue. Runs in
 * web and never loads plugin code — the manifest stored on the row says what
 * to check and which jobs to hand the payload to.
 * - Every refusal before the signature check is one `IngressNotFound`, so a
 *   disabled, degraded, removed or unknown integration reads the same.
 * - The shared secret is the row's `webhook_credential_id`, read from the
 *   vault; never the manifest, never the request.
 */

/** The most a delivery may carry. Checked against Content-Length and again while reading. */
export const INGRESS_MAX_BYTES = 1024 * 1024

/** Where a sender puts `sha256=<hex HMAC-SHA256 of the raw body>`. */
export const INGRESS_SIGNATURE_HEADER = 'x-spaces-signature'

/**
 * The vault provider a plugin's webhook secret is stored under. Not the
 * plugin id itself: `credential` is unique on (scope, provider), and the
 * plugin id already names its API key.
 */
export const webhookSecretProvider = (pluginId: string): string =>
  `${pluginId}:webhook`

/** Never stored: a sender's session or bearer token is not part of the payload. */
const UNSTORED_HEADERS = new Set(['cookie', 'authorization'])

/** Stands in for a path id that is not a uuid, so the lookup still runs. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class IngressNotFound extends Schema.TaggedError<IngressNotFound>()(
  'IngressNotFound',
  {},
) {}

/** A missing or wrong signature, or no secret saved to check it against. */
export class IngressUnauthorized extends Schema.TaggedError<IngressUnauthorized>()(
  'IngressUnauthorized',
  {},
) {}

/** Stored, but the queue did not take the job; the sender should retry. */
export class IngressNotQueued extends Schema.TaggedError<IngressNotQueued>()(
  'IngressNotQueued',
  { payloadId: Schema.String },
) {}

export class IngressFailed extends Schema.TaggedError<IngressFailed>()(
  'IngressFailed',
  { cause: Schema.Defect() },
) {}

export type IngressError =
  IngressNotFound | IngressUnauthorized | IngressNotQueued | IngressFailed

/** One request as the route read it: the path id, lowercased headers, the raw body. */
export type Delivery = {
  readonly integrationId: string
  readonly headers: { readonly [name: string]: string }
  readonly body: Uint8Array
}

export type Received = {
  readonly payloadId: string
  readonly queues: ReadonlyArray<PluginQueueName>
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new IngressFailed({ cause }),
  })

/** `sha256=<hex>` over the raw body — what a sender puts in the signature header. */
export const signWebhook = (secret: string, body: Uint8Array): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

/**
 * Constant-time check of a signature header against the body. Accepts
 * `sha256=<hex>` or bare hex; anything else compares against zeroes and fails.
 */
export const verifySignature = (
  secret: string,
  body: Uint8Array,
  header: string | undefined,
): boolean => {
  const expected = createHmac('sha256', secret).update(body).digest()
  const hex = (header ?? '').trim().replace(/^sha256=/i, '')
  const wellFormed = /^[0-9a-f]{64}$/i.test(hex)
  const given = wellFormed
    ? Buffer.from(hex, 'hex')
    : Buffer.alloc(expected.length)
  return timingSafeEqual(given, expected) && wellFormed
}

/**
 * Reads a request body up to `max` bytes; null as soon as it would pass
 * that, without reading the rest. The second half of the size check — a
 * sender may omit or understate Content-Length.
 */
export const readLimited = async (
  stream: ReadableStream<Uint8Array> | null,
  max: number = INGRESS_MAX_BYTES,
): Promise<Uint8Array | null> => {
  if (stream === null) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** The body as the job is handed it: parsed JSON, else the text itself. */
export const payloadOf = (body: Uint8Array): Json => {
  const text = new TextDecoder().decode(body)
  try {
    const parsed = jsonValue.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : text
  } catch {
    return text
  }
}

const storedHeaders = (headers: Delivery['headers']): IngressHeaders =>
  Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]): [string, string] => [name.toLowerCase(), value])
      .filter(([name]) => !UNSTORED_HEADERS.has(name)),
  )

/** The row and the webhook jobs its stored manifest declares, or not found. */
const routeOf = Effect.fn('routeOf')(function* (integrationId: string) {
  const id = UUID.test(integrationId) ? integrationId : NIL_UUID
  const row = (yield* query(() =>
    db
      .select({
        id: integration.id,
        capabilityId: integration.capabilityId,
        enabled: integration.enabled,
        status: integration.status,
        removedAt: integration.removedAt,
        manifest: integration.manifest,
        webhookCredentialId: integration.webhookCredentialId,
      })
      .from(integration)
      .where(eq(integration.id, id)),
  )).at(0)
  const parsed = manifestSchema.safeParse(row?.manifest)
  const manifest = parsed.success ? parsed.data : null
  const ingress = manifest?.ingress
  const queues =
    manifest === null
      ? []
      : Object.entries(manifest.jobs)
          .filter(([, job]) => job.trigger === 'webhook')
          .map(([job, declared]) =>
            pluginQueueName(manifest.id, job, declared.interactive === true),
          )
  if (
    row === undefined ||
    row.removedAt !== null ||
    !row.enabled ||
    row.status !== 'enabled' ||
    ingress === undefined ||
    queues.length === 0
  )
    return yield* new IngressNotFound()
  return { row, signature: ingress.signature, queues }
})

/**
 * One delivery: look the row up, check the signature the manifest declares,
 * store the raw body, then enqueue `{ payload, receivedAt }` on every webhook
 * job's queue. Nothing is stored or enqueued for a refused delivery.
 */
export const receiveWebhookProgram = Effect.fn('receiveWebhookProgram')(
  function* (
    delivery: Delivery,
  ): Effect.fn.Return<Received, IngressError, Enqueue> {
    const { row, signature, queues } = yield* routeOf(delivery.integrationId)
    if (signature === 'hmac-sha256') {
      const credentialId = row.webhookCredentialId
      if (credentialId === null) return yield* new IngressUnauthorized()
      const secret = yield* query(() => resolveSecretById(credentialId))
      const header = Object.hasOwn(delivery.headers, INGRESS_SIGNATURE_HEADER)
        ? delivery.headers[INGRESS_SIGNATURE_HEADER]
        : undefined
      if (secret === null || !verifySignature(secret, delivery.body, header))
        return yield* new IngressUnauthorized()
    }
    const receivedAt = new Date(yield* Clock.currentTimeMillis)
    const stored = (yield* query(() =>
      db
        .insert(ingressPayload)
        .values({
          integrationId: row.id,
          receivedAt,
          headers: storedHeaders(delivery.headers),
          body: Buffer.from(delivery.body),
        })
        .returning({ id: ingressPayload.id }),
    )).at(0)
    if (!stored)
      return yield* new IngressFailed({ cause: 'insert returned no row' })
    const enqueue = yield* Enqueue
    const data = {
      payload: payloadOf(delivery.body),
      receivedAt: receivedAt.toISOString(),
    }
    for (const queue of queues) {
      const jobId = yield* enqueue.enqueue(queue, data)
      if (jobId === null)
        return yield* new IngressNotQueued({ payloadId: stored.id })
    }
    return { payloadId: stored.id, queues }
  },
)
