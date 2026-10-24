import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { readDeckMessage, readDeckProgram } from '#web/lib/ai/read-deck'
import {
  readDeckSummarizeMessage,
  readDeckSummarizeProgram,
} from '#web/lib/ai/read-deck-summarize'
import type { ReadDeckSummarizeInput } from '#web/lib/ai/read-deck-summarize'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.read-deck: runs the deck reader on the worker.
 * - Every failure is permanent: none is fixed by a retry, and each retried
 *   model call costs. The sentence is the job's output (`JobOutcome.reason`),
 *   which `readDeckStatus` reads back for the toast; it borrows no `document`
 *   column (`extraction_error` is extraction's).
 * - With `summarizeOnto` set it also summarizes onto that record, in one
 *   two-step run; with `capture` set it reads a captured page as that object,
 *   anchored on the document. One queue for all three, so its singleton key
 *   on the document id keeps one read per document at a time.
 */

export const readDeckData = z.object({
  documentId: z.string().uuid(),
  userId: z.string().min(1),
  /** Set by "Read deck and summarize": the record the summary lands on. */
  summarizeOnto: z.string().uuid().optional(),
  /** Set by `POST /api/v1/capture`: the object the page is read as. */
  capture: z.object({ objectId: z.string().uuid() }).optional(),
})

export type ReadDeckData = z.infer<typeof readDeckData>

/** The test seam: one injected model per lane the job may call. */
export type ReadDeckSeam = Pick<
  ReadDeckSummarizeInput,
  'extractModel' | 'synthesizeModel'
>

/** The job's body, with the model seam the test uses. */
export const runReadDeck = (data: ReadDeckData, seam: ReadDeckSeam = {}) =>
  data.summarizeOnto === undefined
    ? readOnly(data, seam)
    : readAndSummarize(data, data.summarizeOnto, seam)

const readOnly = (data: ReadDeckData, seam: ReadDeckSeam) =>
  readDeckProgram({
    documentId: data.documentId,
    userId: data.userId,
    ...(seam.extractModel === undefined ? {} : { model: seam.extractModel }),
    // A captured page anchors on its own document.
    ...(data.capture === undefined
      ? {}
      : {
          against: {
            objectId: data.capture.objectId,
            anchorEntityId: data.documentId,
          },
        }),
  }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] read deck ${data.documentId}: ${String(r.suggestions.length)} suggestion(s), ${String(r.skipped.length)} skipped`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catch(
      (failure) => new JobPermanent({ reason: readDeckMessage(failure) }),
    ),
  )

const readAndSummarize = (
  data: ReadDeckData,
  recordId: string,
  seam: ReadDeckSeam,
) =>
  readDeckSummarizeProgram({
    documentId: data.documentId,
    recordId,
    userId: data.userId,
    ...seam,
  }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] read and summarized ${data.documentId} onto ${recordId}: run ${r.runId}, ${String(r.read.suggestions.length + 1)} suggestion(s)`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catch(
      (failure) =>
        new JobPermanent({ reason: readDeckSummarizeMessage(failure) }),
    ),
  )

export const readDeck: JobDef<ReadDeckData> = {
  name: QUEUES.readDeck,
  schema: readDeckData,
  refs: (data) => ({ entityId: data.documentId }),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runReadDeck(data),
}
