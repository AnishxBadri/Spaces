import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { embedDocumentProgram } from '#web/lib/ai/embed-document'
import type { EmbedDocumentInput } from '#web/lib/ai/embed-document'
import { JobPermanent, JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.embed: extracted text → `chunk` rows, with vectors when a model is
 * pinned. Enqueued by `extractDocument` once the text is stored.
 *
 * Outcome mapping:
 * - no pin / sensitive document → completed; chunks written, no vectors
 * - any other embed failure → JobPermanent with `embedMessage`'s sentence;
 *   chunks are still written for the lexical lane. Not retried: the AI SDK
 *   call already retries outages, and a cap or missing key won't change.
 * - the document vanished → completed
 * - Postgres unreachable → JobRetryable; delete-and-insert in one
 *   transaction makes the run idempotent
 */

export const embedDocumentData = z.object({
  documentId: z.string().uuid(),
})

export type EmbedDocumentData = z.infer<typeof embedDocumentData>

/** The job's body, with the model seam the test uses. */
export const runEmbedDocument = (
  data: EmbedDocumentData,
  seam: Pick<EmbedDocumentInput, 'model'> = {},
) =>
  embedDocumentProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] chunked ${data.documentId}: ${String(r.chunks)} chunk(s), ${r.embeddingModel === null ? `no vectors (${r.skipped ?? 'none'})` : `embedded with ${r.embeddingModel}`}`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catchTags({
      SensitivityEntityNotFound: () =>
        Effect.sync(() => {
          console.warn(
            `[worker] document ${data.documentId} vanished before chunking`,
          )
        }),
      EmbedDocumentFailed: (err) =>
        Effect.fail(
          new JobPermanent({
            reason: `${String(err.chunks)} chunk(s) written without vectors: ${err.reason}`,
          }),
        ),
      EmbedDocumentReadFailed: () =>
        Effect.fail(
          new JobRetryable({ reason: 'Could not read the document' }),
        ),
      SensitivityReadFailed: () =>
        Effect.fail(
          new JobRetryable({ reason: 'Could not resolve sensitivity' }),
        ),
      StampWriteFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'Could not write the chunks' })),
    }),
  )

export const embedDocument: JobDef<EmbedDocumentData> = {
  name: QUEUES.embedDocument,
  schema: embedDocumentData,
  refs: (data) => ({ entityId: data.documentId }),
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  run: (data) => runEmbedDocument(data),
}
