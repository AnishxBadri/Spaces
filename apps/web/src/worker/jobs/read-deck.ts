import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { readDeckMessage, readDeckProgram } from '#/lib/ai/read-deck'
import {
  readDeckSummarizeMessage,
  readDeckSummarizeProgram,
} from '#/lib/ai/read-deck-summarize'
import type { ReadDeckSummarizeInput } from '#/lib/ai/read-deck-summarize'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.read-deck — the deck reader on the worker (SPA-90). The program
 * is `lib/ai/read-deck.ts`; this is the wrapper's view of it.
 *
 * **Every failure is permanent.** A provider that is unreachable, a lane that
 * is not routed, a sensitive record routed to the cloud: none is fixed by
 * pg-boss trying again in thirty seconds, and each retry of a model call is a
 * cost. The failure's sentence is the job's output (`JobOutcome.reason`),
 * which `readDeckStatus` reads back for the Files tab's toast — no column on
 * `document` is borrowed for it; `extraction_error` is extraction's.
 *
 * **Read deck and summarize** (SPA-100) is the same job with
 * `summarizeOnto` set: the record to summarize the deck onto, after the read,
 * in one two-step run (`lib/ai/read-deck-summarize.ts`). One queue, so one
 * deck is read once at a time whichever button was pressed, and the Files
 * tab's status and toast read both the same way.
 *
 * **A captured page** (SPA-134) is the same job again, with `capture` set:
 * the object the page was captured as. The program is the same one —
 * `readDeckProgram` with `against`, anchored on the document — so one
 * extract program serves decks and pages alike, and the queue's singleton
 * key on the document id is what refuses a re-posted page a second read
 * while the first is queued or running. A second queue would have bought
 * nothing but a second worker registration and a second key space for the
 * same one-read-per-document rule.
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
    // A captured page anchors on its own document (SPA-134).
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
