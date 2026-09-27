import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { completeProgram } from '#/lib/ai/complete'
import type { CompleteFailure } from '#/lib/ai/complete'
import { callStep, withRun } from '#/lib/ai/run'
import type { RunScope } from '#/lib/ai/run'
import { sensitivityFor } from '#/lib/ai/sensitivity-for'
import { ref } from '#/lib/context/ref'
import type { SensitivityRead } from '#/lib/ai/sensitivity-for'
import {
  VISION_CHARS_PER_PAGE,
  VISION_MAX_OUTPUT_TOKENS_PER_PAGE,
  VISION_PAGES_PER_CHUNK,
  VisionQueryFailed,
  VisionReadFailed,
  VisionRefused,
  loadPdf,
  pageSections,
  visionChunks,
  visionMessage,
  visionTask,
  visionText,
} from '#/lib/ai/vision'
import type { VisionFailure } from '#/lib/ai/vision'
import { visionReadable } from '#/lib/documents/vision-gate'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'
import { ExtractionStore } from './extract-document'
import type { BlobUnreadable, StoreUnavailable } from './extract-document'

/**
 * document.vision — Read with vision on the worker (SPA-94). The lane, the
 * no-rasterizer decision and the chunk bound are `lib/ai/vision.ts`; this is
 * the job that reads one scanned PDF and, when every page range has
 * answered, writes the text **through extraction's own store**:
 * `ExtractionStore.markExtracted` is the one statement that sets
 * `extracted_text`, `tsv` and `extraction_status: 'done'` together (with the
 * glossary links in the same transaction), and `ExtractionStore.onExtracted`
 * is the `document.extracted` seam, so chunking, embedding and classify
 * follow exactly as they follow a text layer. This file never names a
 * column of `document` it writes — it has none.
 *
 * - **Refused** (the document is gone, has extracted since, is not a stored
 *   PDF at `unsupported`): the job ends, the row is not touched.
 * - **A page range that fails** — the provider's error, an unrouted lane, a
 *   sensitive document routed to the cloud, a cap, a PDF pdf-lib cannot
 *   cut, or a model that read no text at all: nothing is written to the
 *   text; the row stays `unsupported` and `extraction_error` carries the
 *   sentence. Every range is read before anything is written, so no text is
 *   ever half-written.
 *
 * **Every failure is permanent**, the deck reader's rule: none is fixed by a
 * retry in thirty seconds, and each retry re-pays for every page before it.
 */

export const visionDocumentData = z.object({
  documentId: z.string().uuid(),
  userId: z.string().min(1),
})

export type VisionDocumentData = z.infer<typeof visionDocumentData>

/** The test seam: an injected model, and a smaller chunk to see the split. */
export type VisionSeam = { model?: LanguageModel; pagesPerChunk?: number }

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new VisionQueryFailed({ cause }),
  })

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

type Doc = { filename: string; blobSha: string }

/**
 * Every page range through `complete('vision', …)`, in order, one chunk in
 * memory at a time; the sections of all of them, or the failure that stops
 * the read. Writes nothing.
 */
const readPages = Effect.fn('visionDocument.readPages')(function* (
  documentId: string,
  doc: Doc,
  bytes: Uint8Array,
  opts: {
    userId: string
    sensitivity: SensitivityRead
    seam: VisionSeam
    run: RunScope
  },
): Effect.fn.Return<
  Array<{ page: number; text: string }>,
  VisionReadFailed | CompleteFailure
> {
  const src = yield* Effect.tryPromise({
    try: () => loadPdf(bytes),
    catch: (cause) =>
      new VisionReadFailed({
        message: `The PDF could not be opened for vision: ${messageOf(cause)}`,
      }),
  })
  const chunks = visionChunks(
    src,
    opts.seam.pagesPerChunk ?? VISION_PAGES_PER_CHUNK,
  )
  const sections: Array<{ page: number; text: string }> = []
  const runId = yield* opts.run.id
  for (;;) {
    // The next chunk is cut only once the previous one's call has answered,
    // so one range's bytes are in flight at a time.
    const next = yield* Effect.tryPromise({
      try: () => chunks.next(),
      catch: (cause) =>
        new VisionReadFailed({
          message: `The PDF could not be split into pages: ${messageOf(cause)}`,
        }),
    })
    if (next.done === true) break
    const { range, bytes: part } = next.value
    const pages = range.last - range.first + 1
    const answered = yield* completeProgram('vision', [], undefined, {
      caller: { type: 'user', id: opts.userId },
      sensitivity: opts.sensitivity.sensitivity,
      ...(opts.sensitivity.sensitivity === 'sensitive'
        ? { via: opts.sensitivity.via }
        : {}),
      budgetChars: VISION_CHARS_PER_PAGE * pages,
      task: visionTask(range, doc.filename),
      files: [
        {
          mediaType: 'application/pdf',
          data: part,
          name: `${doc.filename} pp.${String(range.first)}-${String(range.last)}.pdf`,
        },
      ],
      maxOutputTokens: VISION_MAX_OUTPUT_TOKENS_PER_PAGE * pages,
      ...(opts.seam.model === undefined ? {} : { model: opts.seam.model }),
      runId,
    })
    // One step per page range, in order. The input is the document's bytes
    // (the grammar's whole-document ref); the text is written only once
    // every range has answered, so no range has an output of its own.
    yield* opts.run.step(
      callStep('vision', [ref.doc(documentId, 0)], answered, null, undefined),
    )
    const text = answered.output.kind === 'text' ? answered.output.text : ''
    const read = pageSections(text, range)
    sections.push(...read)
    console.log(
      `[worker] vision ${documentId} pp.${String(range.first)}-${String(range.last)}: ${String(read.length)} page(s) with text, ${String(answered.usage.tokensIn ?? '?')} in / ${String(answered.usage.tokensOut ?? '?')} out`,
    )
  }
  if (sections.length === 0)
    return yield* new VisionReadFailed({
      message: `The vision model read no text from ${doc.filename}`,
    })
  return sections
})

const program = Effect.fn('visionDocument')(function* (
  data: VisionDocumentData,
  seam: VisionSeam,
  run: RunScope,
): Effect.fn.Return<
  void,
  VisionFailure | StoreUnavailable | BlobUnreadable | JobPermanent,
  ExtractionStore
> {
  const { documentId } = data
  const store = yield* ExtractionStore
  const row = (yield* query(() =>
    db
      .select({
        extractionStatus: document.extractionStatus,
        blobSha: document.blobSha,
        filename: document.filename,
        mime: document.mime,
      })
      .from(document)
      .where(eq(document.entityId, documentId)),
  )).at(0)
  if (!row)
    return yield* new VisionRefused({ message: 'That document is gone' })
  if (row.blobSha === null || !visionReadable(row))
    return yield* new VisionRefused({
      message: 'Only a stored PDF with no text layer is read with vision',
    })
  const doc: Doc = {
    filename: row.filename ?? 'the document',
    blobSha: row.blobSha,
  }

  const sensitivity = yield* sensitivityFor(documentId)
  const bytes = yield* store.bytes(doc.blobSha)

  const sections = yield* readPages(documentId, doc, bytes, {
    userId: data.userId,
    sensitivity,
    seam,
    run,
  }).pipe(
    Effect.catch((failure) => {
      // The read failed: the row stays `unsupported`, its text untouched,
      // and the provider's sentence is what the operator reads on it.
      const reason = visionMessage(failure)
      return store
        .markFailed(documentId, 'unsupported', reason)
        .pipe(Effect.andThen(Effect.fail(new JobPermanent({ reason }))))
    }),
  )

  // Extraction's statement, then extraction's hand-off — the sanctioned
  // AI write to a document, and nothing else here writes one.
  const text = visionText(sections)
  yield* store.markExtracted(documentId, text)
  yield* store.onExtracted(documentId)
  console.log(
    `[worker] vision read ${String(sections.length)} page(s), ${String(text.length)} chars, from ${doc.filename}`,
  )
})

type ProgramFailure =
  VisionFailure | StoreUnavailable | BlobUnreadable | JobPermanent

/** The sentence a failure leaves — on the job, and on the run (SPA-100). */
const reasonOf = (failure: ProgramFailure): string =>
  failure._tag === 'JobPermanent'
    ? failure.reason
    : failure._tag === 'StoreUnavailable'
      ? `document store unavailable during ${failure.operation}: ${failure.message}`
      : failure._tag === 'BlobUnreadable'
        ? `Blob ${failure.blobSha.slice(0, 12)} unreadable: ${failure.message}`
        : visionMessage(failure)

/**
 * The job's body, with the seam the test uses. One run per read ("Read with
 * vision"), opened at the first page range's call, a step per range.
 */
export const runVisionDocument = (
  data: VisionDocumentData,
  seam: VisionSeam = {},
) =>
  withRun(
    undefined,
    {
      task: 'Read with vision',
      entityId: data.documentId,
      startedBy: { type: 'user', id: data.userId },
    },
    (run) => program(data, seam, run),
    reasonOf,
  ).pipe(
    Effect.catch((failure) =>
      Effect.fail(
        failure._tag === 'JobPermanent'
          ? failure
          : new JobPermanent({ reason: reasonOf(failure) }),
      ),
    ),
  )

export const visionDocument: JobDef<VisionDocumentData, ExtractionStore> = {
  name: QUEUES.visionDocument,
  schema: visionDocumentData,
  refs: (data) => ({ entityId: data.documentId }),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runVisionDocument(data),
}
