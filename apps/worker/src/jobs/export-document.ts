import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  exportDocumentProgram,
  exportPlanOf,
  exportTargetOf,
  writableOf,
  writesThrough,
} from '@spaces/core/writes/bindings/export'
import type { ExportOutcome } from '@spaces/core/writes/bindings/export'
import { PluginBreaker } from './plugin-breaker'
import { StorageSources } from './storage-sources'
import { JobPermanent, JobRateLimited, JobRetryable } from '../run-job'
import type { JobDef, JobRetryPolicy } from '../run-job'

/**
 * storage.export, write-through: an in-app upload on a pushing binding's
 * record is put in the bound folder through the storage-source plugin with
 * the binding's grant, its pointer recorded by `exportDocumentProgram`; an
 * exported document re-filed or renamed here is moved or renamed there.
 * - A pull-only binding, a non-upload, a `gone` row or a deleted document
 *   is a no-op, never a failure.
 * - No usable connection (none bound, refused token, no plugin) is
 *   retryable: the job waits with backoff and the row counts on Today.
 *   A refused token is the connection's fault, so the breaker is not charged.
 * - A provider that cannot write, the bound folder gone, or the bytes gone
 *   fail for good.
 */

export const exportDocumentData = z.object({
  documentId: z.string().uuid(),
})

export type ExportDocumentData = z.infer<typeof exportDocumentData>

/**
 * About a day of waiting for a connection: 60 s doubling to the one-hour cap
 * (`EXPORT_RETRY_DELAY_MAX_SECONDS`) by the sixth retry, then hourly — 30
 * retries span roughly 25 hours.
 */
export const exportDocumentRetry: JobRetryPolicy = {
  limit: 30,
  delaySeconds: 60,
  backoff: true,
}

export const EXPORT_RETRY_DELAY_MAX_SECONDS = 60 * 60

/** The provider as Today and a job's reason name it. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  google: 'Drive',
  box: 'Box',
}

export const providerName = (provider: string) =>
  PROVIDER_NAMES[provider] ?? provider

const waiting = (provider: string, why: string) =>
  new JobRetryable({
    reason: `waiting for a ${providerName(provider)} connection: ${why}`,
  })

const store = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  effect.pipe(
    Effect.mapError(
      () => new JobRetryable({ reason: 'document store unavailable' }),
    ),
  )

const said = (outcome: ExportOutcome): string => {
  switch (outcome._tag) {
    case 'exported':
      return `exported as ${outcome.fileId}`
    case 'moved':
      return 'moved to its new binding'
    case 'kept':
      return 'already in place'
    case 'deleted':
      return 'deleted while uploading; tombstoned'
  }
}

const program = Effect.fn('exportDocument')(function* (
  data: ExportDocumentData,
) {
  const plan = yield* store(exportPlanOf(data.documentId))
  if (plan === null)
    return 'the document or its binding is gone; nothing exported'
  if (plan.sourceClass !== 'manual') return 'not an upload; nothing exported'
  if (plan.externalStatus === 'gone')
    return 'gone at the provider; nothing exported'
  if (!writesThrough(plan.home.direction))
    return 'the binding is pull-only; nothing exported'
  if (plan.blobSha === null) return 'no bytes; nothing exported'
  const { home } = plan
  if (home.connectionId === null)
    return yield* waiting(home.provider, 'the binding has no connection')
  if (home.status === 'paused')
    return yield* waiting(home.provider, 'the binding is paused')

  const sources = yield* StorageSources
  const opened = yield* sources
    .open({ provider: home.provider, connectionId: home.connectionId })
    .pipe(
      Effect.catchTag('StorageSourceUnavailable', (e) =>
        Effect.fail(waiting(home.provider, e.reason)),
      ),
    )
  const source = writableOf(opened.source)
  if (source === null)
    return yield* new JobPermanent({
      reason: `the ${providerName(home.provider)} plugin cannot write`,
    })

  const breaker = yield* PluginBreaker
  const outcome = yield* exportDocumentProgram({
    plan,
    blobSha: plan.blobSha,
    source,
  }).pipe(
    Effect.catchTags({
      AuthExpired: (e) => Effect.fail(waiting(home.provider, e.reason)),
      RateLimited: (e) =>
        Effect.fail(
          new JobRateLimited({
            reason: 'The provider asked to slow down',
            retryAfterMs: e.retryAfterMs,
          }),
        ),
      NotFound: () => {
        const reason = 'the bound folder or the exported file is gone'
        return breaker
          .charge(opened.integrationId, `permanent: ${reason}`)
          .pipe(Effect.andThen(Effect.fail(new JobPermanent({ reason }))))
      },
      ExportBytesGone: () =>
        Effect.fail(new JobPermanent({ reason: 'the stored bytes are gone' })),
      BindingStoreFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'document store unavailable' })),
    }),
  )
  return said(outcome)
})

export const exportDocument: JobDef<
  ExportDocumentData,
  StorageSources | PluginBreaker
> = {
  name: QUEUES.exportDocument,
  schema: exportDocumentData,
  // The bound record: the run shows in its history. A gone document has none.
  lookupRefs: async (data) => ({
    entityId: await exportTargetOf(data.documentId),
  }),
  retry: exportDocumentRetry,
  run: (data) => Effect.scoped(program(data)),
}
