import { Effect } from 'effect'
import {
  INGRESS_MAX_BYTES,
  readLimited,
  receiveWebhookProgram,
} from '@spaces/core/writes/ingress/receive'
import type { IngressError } from '@spaces/core/writes/ingress/receive'
import { webEnqueue } from '#/lib/enqueue-live'

/**
 * `/api/webhooks/$id` as a Request → Response: the size limit, then core's
 * verify → store → enqueue program, each refusal mapped to its status.
 * - Every not-found case answers the same body after the same lookup, so an
 *   id cannot be probed for existence.
 * - Unauthenticated by design: the signature is the authorization.
 */

const text = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })

const TOO_LARGE = () =>
  text(413, `Payload larger than ${String(INGRESS_MAX_BYTES)} bytes`)

const refusal = (error: IngressError): Response => {
  switch (error._tag) {
    case 'IngressNotFound':
      return text(404, 'Not found')
    case 'IngressUnauthorized':
      return text(401, 'Unauthorized')
    case 'IngressNotQueued':
      return text(503, 'Stored but not queued; retry')
    case 'IngressFailed':
      console.error('[ingress] could not accept a delivery', error.cause)
      return text(500, 'Could not accept the delivery')
  }
}

export async function handleWebhook(
  request: Request,
  integrationId: string,
): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > INGRESS_MAX_BYTES) return TOO_LARGE()
  const body = await readLimited(request.body, INGRESS_MAX_BYTES)
  if (body === null) return TOO_LARGE()
  const headers = Object.fromEntries(request.headers.entries())
  return Effect.runPromise(
    receiveWebhookProgram({ integrationId, headers, body }).pipe(
      Effect.match({
        onSuccess: () => Response.json({ received: true }),
        onFailure: refusal,
      }),
      Effect.provide(webEnqueue),
    ),
  )
}
