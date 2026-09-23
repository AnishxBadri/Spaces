import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { embedSourceProgram } from '#/lib/ai/embed-source'
import type { EmbedSourceInput } from '#/lib/ai/embed-source'
import type { EmbedSource } from '#/lib/ai/chunk-sources'
import { JobPermanent, JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * chunk.embed — a note's text or an embeddable attribute value → `chunk`
 * rows, with vectors when a model is pinned (SPA-132). The program is
 * `lib/ai/embed-source.ts`; the outcome mapping is `document.embed`'s
 * (`./embed-document.ts`), because the write underneath is the same
 * `replaceChunks`:
 *
 *   - no pin / sensitive record     → completed; chunks written, no vectors
 *   - the source is gone or merged  → completed, nothing to do
 *   - any other embed failure       → JobPermanent with `embedMessage`'s
 *     sentence; the chunks were still written, without vectors
 *   - a slug not on the embeddable list → JobPermanent; the payload is wrong
 *     and will be wrong on every retry
 *   - Postgres unreachable          → JobRetryable; delete-and-insert in one
 *     transaction, so a retry is safe
 */

export const embedSourceData = z.discriminatedUnion('sourceKind', [
  z.object({
    entityId: z.string().uuid(),
    sourceKind: z.literal('note'),
    sourceKey: z.literal(''),
  }),
  z.object({
    entityId: z.string().uuid(),
    sourceKind: z.literal('attribute'),
    sourceKey: z.string().min(1),
  }),
])

export type EmbedSourceData = z.infer<typeof embedSourceData>

const label = (s: EmbedSource) =>
  s.sourceKind === 'note'
    ? `note ${s.entityId}`
    : `${s.sourceKey} on ${s.entityId}`

/** The job's body, with the model seam the test uses. */
export const runEmbedSource = (
  data: EmbedSourceData,
  seam: Pick<EmbedSourceInput, 'model'> = {},
) =>
  embedSourceProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] chunked ${label(data)}: ${String(r.chunks)} chunk(s), ${r.embeddingModel === null ? `no vectors (${r.skipped ?? 'none'})` : `embedded with ${r.embeddingModel}`}`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catchTags({
      SensitivityEntityNotFound: () =>
        Effect.sync(() => {
          console.warn(`[worker] ${label(data)} vanished before chunking`)
        }),
      NotEmbeddable: (err) =>
        Effect.fail(
          new JobPermanent({
            reason: `${err.slug} is not an embeddable attribute of a ${err.kind}`,
          }),
        ),
      EmbedSourceFailed: (err) =>
        Effect.fail(
          new JobPermanent({
            reason: `${String(err.chunks)} chunk(s) written without vectors: ${err.reason}`,
          }),
        ),
      EmbedSourceReadFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'Could not read the source' })),
      SensitivityReadFailed: () =>
        Effect.fail(
          new JobRetryable({ reason: 'Could not resolve sensitivity' }),
        ),
      StampWriteFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'Could not write the chunks' })),
    }),
  )

export const embedSource: JobDef<EmbedSourceData> = {
  name: QUEUES.embedSource,
  schema: embedSourceData,
  refs: (data) => ({ entityId: data.entityId }),
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  run: (data) => runEmbedSource(data),
}
