import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { ledgerTargetOf } from '#/lib/ai/ledger-event'
import { isLaneRoutedProgram } from '#/lib/ai/route'
import { sensitivityFor } from '#/lib/ai/sensitivity-for'
import { enqueue } from '#/lib/queue'

/**
 * `document.extracted`: the one place the follow-on lanes of an extraction
 * are enqueued, called only from the extract job's success path once text and
 * tsv are committed. A new follow-on lane registers here, never in the job.
 * - `document.embed`, always: chunking runs with or without an embedding pin.
 * - `document.classify`, only when the kind is still `other` **and** the lane
 *   is routed at the resolved sensitivity. A kind set at filing is never
 *   classified.
 * - `document.ledger-event`, only for a cap table revision (never a first
 *   filing) on a held company, extract routed at the stricter sensitivity.
 *   Keyed on (document, revision).
 *
 * It never fails: an enqueue or routing read that goes wrong must not turn a
 * committed extraction into a retry.
 */
export const onDocumentExtracted = Effect.fn('onDocumentExtracted')(function* (
  documentId: string,
): Effect.fn.Return<void> {
  // `enqueue` answers null rather than throwing when the queue is down.
  yield* Effect.promise(() => enqueue(QUEUES.embedDocument, { documentId }))
  if (yield* wantsClassify(documentId))
    yield* Effect.promise(() =>
      enqueue(
        QUEUES.classifyDocument,
        { documentId },
        { singletonKey: documentId },
      ),
    )
  const revisionId = yield* wantsLedgerEvent(documentId)
  if (revisionId !== null)
    yield* Effect.promise(() =>
      enqueue(
        QUEUES.proposeLedgerEvent,
        { documentId, revisionId },
        { singletonKey: `${documentId}:${revisionId}` },
      ),
    )
})

/**
 * Routed first, because it is the cheap answer on a box with no provider:
 * `isLaneRouted` never fails and reads unrouted on any error. Only then the
 * document's kind, and only for an `other` its sensitivity — the cell of the
 * grid the job's `complete()` call will be routed through.
 */
const classifyGate = Effect.fn('onDocumentExtracted.classifyGate')(function* (
  documentId: string,
) {
  const routed = yield* isLaneRoutedProgram('classify', null)
  if (!routed.normal && !routed.sensitive) return false
  const row = (yield* Effect.tryPromise({
    try: () =>
      db
        .select({ kind: document.kind })
        .from(document)
        .where(eq(document.entityId, documentId)),
    catch: (cause) => cause,
  })).at(0)
  if (row?.kind !== 'other') return false
  const { sensitivity } = yield* sensitivityFor(documentId)
  return routed[sensitivity]
})

/** The gate, with a read that failed answering "no" out loud. */
const wantsClassify = (documentId: string): Effect.Effect<boolean> =>
  classifyGate(documentId).pipe(
    Effect.catch((cause) =>
      Effect.sync(() => {
        console.warn(
          `[worker] ${documentId}: classify not enqueued after extraction`,
          cause,
        )
        return false
      }),
    ),
  )

/**
 * The revision to read, or null: a revised cap table on a held company, with
 * the extract lane routed at the stricter of the document's and the
 * company's sensitivity. Routed first, the cheap answer on a keyless box.
 */
const ledgerEventGate = Effect.fn('onDocumentExtracted.ledgerEventGate')(
  function* (documentId: string) {
    const routed = yield* isLaneRoutedProgram('extract', null)
    if (!routed.normal && !routed.sensitive) return null
    const read = yield* Effect.tryPromise({
      try: () => ledgerTargetOf(documentId),
      catch: (cause) => cause,
    })
    if (!read.ok) return null
    const ofDocument = yield* sensitivityFor(documentId)
    const ofCompany = yield* sensitivityFor(read.target.companyId)
    const sensitive =
      ofDocument.sensitivity === 'sensitive' ||
      ofCompany.sensitivity === 'sensitive'
    return routed[sensitive ? 'sensitive' : 'normal']
      ? read.target.revisionId
      : null
  },
)

const wantsLedgerEvent = (documentId: string): Effect.Effect<string | null> =>
  ledgerEventGate(documentId).pipe(
    Effect.catch((cause) =>
      Effect.sync(() => {
        console.warn(
          `[worker] ${documentId}: ledger event not enqueued after extraction`,
          cause,
        )
        return null
      }),
    ),
  )
