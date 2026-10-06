import { Clock, Effect, Schema } from 'effect'
import { lt } from 'drizzle-orm'
import { db } from '@spaces/db'
import { ingressPayload } from '@spaces/db/schema'

/**
 * Stored webhook deliveries are kept this many days, then deleted by the
 * nightly `ingress.prune` job. Long enough to read back a delivery a job
 * mishandled; the job itself was handed the payload when it arrived.
 */
export const INGRESS_RETENTION_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export class IngressPruneFailed extends Schema.TaggedError<IngressPruneFailed>()(
  'IngressPruneFailed',
  { cause: Schema.Defect() },
) {}

/** Deletes every `ingress_payload` row received more than `retentionDays` ago. */
export const pruneIngressPayloadsProgram = Effect.fn(
  'pruneIngressPayloadsProgram',
)(function* (
  retentionDays: number = INGRESS_RETENTION_DAYS,
): Effect.fn.Return<{ readonly deleted: number }, IngressPruneFailed> {
  const cutoff = new Date(
    (yield* Clock.currentTimeMillis) - retentionDays * DAY_MS,
  )
  const deleted = yield* Effect.tryPromise({
    try: () =>
      db
        .delete(ingressPayload)
        .where(lt(ingressPayload.receivedAt, cutoff))
        .returning({ id: ingressPayload.id }),
    catch: (cause) => new IngressPruneFailed({ cause }),
  })
  return { deleted: deleted.length }
})
