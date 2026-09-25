import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { isLaneRoutedProgram } from '#/lib/ai/route'
import { sensitivityFor } from '#/lib/ai/sensitivity-for'
import { enqueue } from '#/lib/queue'

/**
 * `document.extracted` (SPA-62; docs/spec-ai-substrate.md §11): the one
 * place the follow-on lanes of an extraction are enqueued. Called from
 * exactly one site — extractDocument's success path, once the text and tsv
 * are committed — and it does nothing but enqueue. A lane that wants to run
 * after extraction registers here instead of editing the extraction job;
 * `on-extracted.test.ts` greps the tree to hold both halves of that.
 *
 * The lanes, in order:
 *
 *   - `document.embed` (SPA-121), always: chunking runs with or without an
 *     embedding pin, so the lexical chunk lane has rows on a keyless box.
 *   - `document.classify` (SPA-62), only when the document's kind is still
 *     `other` **and** the classify lane is routed at the document's resolved
 *     sensitivity. A kind set at filing time — by `guessDocumentKind` off
 *     the filename, by a bound folder, by a person — is never classified.
 *
 * It never fails: the text it follows is already committed, and an enqueue
 * or a routing read that goes wrong must not turn a good extraction into a
 * retry. With the classify lane unrouted it reads the routing table, finds
 * nothing, and returns — no document read, no log line.
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
