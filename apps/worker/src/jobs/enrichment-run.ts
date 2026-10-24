import { Effect, Layer } from 'effect'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { enrichmentRunData } from '@spaces/core/enrichment/auto'
import type { EnrichmentRunData } from '@spaces/core/enrichment/auto'
import { runEnrichment } from '@spaces/core/writes/enrichment/run'
import type { RunOutcome } from '@spaces/core/writes/enrichment/run'
import type { EnrichmentSources } from '@spaces/core/enrichment/sources'
import { WebsiteReader } from '@spaces/core/enrichment/website'
import type { ExtractRoute, FetchedPage } from '@spaces/core/enrichment/website'
import type { ModelCall } from '@spaces/core/writes/ports/ai'
import type { JobError } from '@spaces/sdk'
import {
  aiRouteProgram,
  isLaneRoutedProgram,
  isLocalProvider,
} from '#web/lib/ai/route'
import { guardedFetch } from '#web/lib/documents/fetch-guard'
import { enqueue } from '#web/lib/queue'
import { JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'
import { CLIP_MAX_BYTES, CLIP_TIMEOUT_MS } from './clip-document'

/**
 * enrichment.run: one record enriched from the owner's sources in order. The
 * summary is the run's timeline line in short, or why nothing was asked, and
 * when it parked for a source's daily cap.
 * - An auto run carries its trigger and the sources in scope, a list's
 *   Enrich… the sources that pass its checks and `bulk`; the Enrich button
 *   sends none of them and asks every source.
 */

const summaryOf = (outcome: RunOutcome): string => {
  const ran = outcome.ran
    ? `${String(outcome.fields)} field(s), ${String(outcome.credits)} credit(s)`
    : `nothing asked: ${outcome.reason}`
  return outcome.parked === null
    ? ran
    : `${ran}; parked until ${outcome.parked.startAfter}`
}

/** The embeds a run hands back, through the worker's sender. */
export const enrichmentEnqueue: Layer.Layer<Enqueue> = Enqueue.fromSender({
  enqueue: (queue, data, options) => enqueue(queue, data, options),
})

/**
 * The Website source's reads: a page — or a record's picture, under its
 * own lower cap — through the URL guard under the clip's caps (size, time,
 * no JavaScript), and the Extract lane's route as the AI router and the
 * trigger gate read it.
 */
export const WebsiteReaderLive = (
  caps: { readonly maxBytes?: number; readonly timeoutMs?: number } = {},
): Layer.Layer<WebsiteReader> =>
  Layer.succeed(
    WebsiteReader,
    WebsiteReader.of({
      fetch: (url, own) =>
        Effect.promise(() =>
          guardedFetch(url, {
            maxBytes: Math.min(
              own?.maxBytes ?? CLIP_MAX_BYTES,
              caps.maxBytes ?? CLIP_MAX_BYTES,
            ),
            timeoutMs: caps.timeoutMs ?? CLIP_TIMEOUT_MS,
          }),
        ).pipe(
          Effect.map((r): FetchedPage =>
            r.ok
              ? {
                  ok: true,
                  url: r.url,
                  contentType: r.contentType,
                  bytes: r.bytes,
                }
              : r.tooLarge === true
                ? { ok: false, reason: r.reason, tooLarge: true }
                : { ok: false, reason: r.reason },
          ),
        ),
      extractRoute: Effect.fn('WebsiteReader.extractRoute')(function* (
        sensitivity: 'normal' | 'sensitive',
      ): Effect.fn.Return<ExtractRoute, JobError> {
        const target = yield* aiRouteProgram('extract', sensitivity).pipe(
          Effect.catchTag('LaneNotRouted', () => Effect.succeed(null)),
          Effect.mapError(
            () =>
              new JobRetryable({
                reason: 'Website: could not read the AI routing',
              }),
          ),
        )
        if (target === null) return 'unrouted'
        const local = isLocalProvider(target.provider)
        if (sensitivity === 'sensitive' && !local) return 'cloud'
        const routed = yield* isLaneRoutedProgram('extract', null)
        if (!routed[sensitivity]) return 'unrouted'
        return local ? 'local' : 'cloud'
      }),
    }),
  )

export const enrichmentRun: JobDef<
  EnrichmentRunData,
  EnrichmentSources | Enqueue | WebsiteReader | ModelCall
> = {
  name: QUEUES.enrichmentRun,
  schema: enrichmentRunData,
  refs: (data) => ({ entityId: data.entityId }),
  retry: { limit: 2, delaySeconds: 60, backoff: true },
  run: (data) =>
    runEnrichment(data.entityId, data.reason, {
      ...(data.sources === undefined ? {} : { only: data.sources }),
      ...(data.trigger === undefined ? {} : { trigger: data.trigger }),
      ...(data.bulk === undefined ? {} : { bulk: data.bulk }),
    }).pipe(Effect.map(summaryOf)),
}
