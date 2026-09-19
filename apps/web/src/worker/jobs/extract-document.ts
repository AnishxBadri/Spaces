import { createHash } from 'node:crypto'
import { Context, Effect, Layer, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { storage } from '#/lib/storage'
import { extractDocumentText } from '@spaces/core/documents/extract'
import { QUEUES } from '@spaces/core/queue/names'
import { JobContext, JobPermanent, JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.extract — the reason the worker process exists. Parsing a 200-page
 * PDF or a 90MB deck is CPU-bound; run it on the web process and every other
 * request waits behind it.
 *
 * Writes extracted_text and tsv together in one statement: they must never
 * disagree, or search silently returns rows whose text says otherwise.
 *
 * First tenant of the `runJob` wrapper (SPA-49), and that is a behaviour
 * change, not a rewrite: this handler used to swallow every failure into
 * document.extraction_status and complete the job, so nothing ever retried.
 * The mapping is now explicit and asserted in extract-document.test.ts —
 *
 *   - blob unreadable (a transient store read)  → JobRetryable; the row is
 *     left alone while retries remain and only the final attempt writes
 *     'failed', so the operator sees "pending" not "failed" mid-retry
 *   - no stored blob                            → JobPermanent, 'unsupported'
 *   - sha mismatch                              → JobPermanent, 'failed'
 *   - extractor says unsupported/failed         → JobPermanent, that status
 *
 * The operator-facing reason text is byte-identical to the pre-wrapper
 * strings in every one of those branches.
 */

export const extractDocumentData = z.object({
  documentId: z.string().uuid(),
})

export type ExtractDocumentData = z.infer<typeof extractDocumentData>

export interface DocumentForExtraction {
  readonly blobSha: string | null
  readonly filename: string | null
  readonly mime: string | null
}

/** The store read failed — Postgres or the blob backend, not the document. */
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  'StoreUnavailable',
  { operation: Schema.String, message: Schema.String },
) {}

/** The blob is not readable right now. May well be next attempt. */
export class BlobUnreadable extends Schema.TaggedError<BlobUnreadable>()(
  'BlobUnreadable',
  { blobSha: Schema.String, message: Schema.String },
) {}

/** The document cannot be extracted, now or ever. Terminal, and explainable. */
export class ExtractionFailed extends Schema.TaggedError<ExtractionFailed>()(
  'ExtractionFailed',
  {
    status: Schema.Literals(['unsupported', 'failed']),
    reason: Schema.String,
  },
) {}

/**
 * The job's Layer. Splitting the I/O out of the program is what lets the
 * retryable-versus-terminal mapping be asserted without a Postgres or a blob
 * store — and it is the shape every plugin job will take.
 */
export class ExtractionStore extends Context.Service<
  ExtractionStore,
  {
    readonly read: (
      documentId: string,
    ) => Effect.Effect<DocumentForExtraction | null, StoreUnavailable>
    readonly bytes: (
      blobSha: string,
    ) => Effect.Effect<Uint8Array, BlobUnreadable>
    readonly markExtracted: (
      documentId: string,
      text: string,
    ) => Effect.Effect<void, StoreUnavailable>
    readonly markFailed: (
      documentId: string,
      status: 'unsupported' | 'failed',
      reason: string,
    ) => Effect.Effect<void, StoreUnavailable>
  }
>()('spaces/worker/ExtractionStore') {
  static readonly layer = Layer.succeed(
    ExtractionStore,
    ExtractionStore.of({
      read: (documentId) =>
        Effect.tryPromise({
          try: async () =>
            (
              await db
                .select({
                  blobSha: document.blobSha,
                  filename: document.filename,
                  mime: document.mime,
                })
                .from(document)
                .where(eq(document.entityId, documentId))
            ).at(0) ?? null,
          catch: (err) =>
            new StoreUnavailable({
              operation: 'read',
              message: messageOf(err),
            }),
        }),
      bytes: (blobSha) =>
        Effect.tryPromise({
          try: () => storage().getBytes(blobSha),
          catch: (err) =>
            new BlobUnreadable({ blobSha, message: messageOf(err) }),
        }),
      markExtracted: (documentId, text) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .update(document)
              .set({
                extractedText: text,
                // 'english' matches the tsvector config used by the search
                // indexes; changing it here alone would make writes and
                // queries disagree.
                tsv: sql`to_tsvector('english', ${text})`,
                extractionStatus: 'done',
                extractionError: null,
                extractedAt: new Date(),
              })
              .where(eq(document.entityId, documentId))
          },
          catch: (err) =>
            new StoreUnavailable({
              operation: 'markExtracted',
              message: messageOf(err),
            }),
        }),
      markFailed: (documentId, status, reason) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .update(document)
              .set({
                extractionStatus: status,
                extractionError: reason.slice(0, 500),
                extractedAt: new Date(),
              })
              .where(eq(document.entityId, documentId))
          },
          catch: (err) =>
            new StoreUnavailable({
              operation: 'markFailed',
              message: messageOf(err),
            }),
        }),
    }),
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const program = Effect.fn('extractDocument')(function* (
  data: ExtractDocumentData,
) {
  const { documentId } = data
  const store = yield* ExtractionStore
  const row = yield* store.read(documentId)

  if (!row) {
    console.warn(`[worker] document ${documentId} vanished before extraction`)
    return
  }
  if (!row.blobSha) {
    return yield* new ExtractionFailed({
      status: 'unsupported',
      reason: 'No stored file to extract text from',
    })
  }
  const blobSha = row.blobSha

  const bytes = yield* store.bytes(blobSha)

  // Universal integrity backstop (2026-08): the local driver verifies on
  // write and enforcing S3 endpoints verify on PUT, but partially-compatible
  // targets (Garage) may not. We're holding the whole blob anyway, so
  // re-verify "same sha ⇒ same bytes" here — the invariant dedupe and the
  // immutable cache header lean on.
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== blobSha) {
    return yield* new ExtractionFailed({
      status: 'failed',
      reason: `Blob integrity check failed: stored bytes hash ${digest.slice(0, 12)}, expected ${blobSha.slice(0, 12)}. The storage backend accepted a corrupt upload.`,
    })
  }

  // Deliberately Effect.promise, not tryPromise: an extractor that throws is
  // a bug, and the wrapper's defect path is where bugs belong. Mapping it to
  // a reason string here would invent operator-facing text for a case the
  // pre-wrapper handler never had one for either.
  const outcome = yield* Effect.promise(() =>
    extractDocumentText({
      bytes,
      filename: row.filename,
      mime: row.mime,
    }),
  )

  if (outcome.status !== 'done') {
    return yield* new ExtractionFailed({
      status: outcome.status,
      reason: outcome.reason,
    })
  }

  yield* store.markExtracted(documentId, outcome.text)

  console.log(
    `[worker] extracted ${outcome.text.length} chars from ${row.filename ?? documentId} (${outcome.format})`,
  )
})

/**
 * Records the terminal status on the row, then fails the job permanently.
 * The row write is what the operator reads; the JobPermanent is what stops
 * pg-boss retrying something that will never succeed.
 */
const onExtractionFailed = Effect.fn('extractDocument.onExtractionFailed')(
  function* (documentId: string, err: ExtractionFailed) {
    const store = yield* ExtractionStore
    yield* store.markFailed(documentId, err.status, err.reason)
    console.warn(`[worker] ${err.status} ${documentId}: ${err.reason}`)
    return yield* new JobPermanent({ reason: err.reason })
  },
)

/**
 * A blob we could not read is the one failure worth another attempt. The row
 * stays 'pending' while attempts remain so the operator is not told the
 * document failed by a retry that is still coming; the final attempt writes
 * the same 'failed' reason the old handler wrote on the first one.
 */
const onBlobUnreadable = Effect.fn('extractDocument.onBlobUnreadable')(
  function* (documentId: string, err: BlobUnreadable) {
    const ctx = yield* JobContext
    const store = yield* ExtractionStore
    const reason = `Blob ${err.blobSha.slice(0, 12)} unreadable: ${err.message}`
    if (ctx.isFinalAttempt) {
      yield* store.markFailed(documentId, 'failed', reason)
      console.warn(`[worker] failed ${documentId}: ${reason}`)
    } else {
      console.warn(
        `[worker] ${documentId}: ${reason} — attempt ${ctx.attempt}, retrying`,
      )
    }
    return yield* new JobRetryable({ reason })
  },
)

export const extractDocument: JobDef<ExtractDocumentData, ExtractionStore> = {
  name: QUEUES.extractDocument,
  schema: extractDocumentData,
  // Extraction is CPU-bound and synchronous once it starts, so an Effect
  // timeout could not interrupt it — pg-boss's own expiry is the backstop.
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  run: (data) =>
    program(data).pipe(
      Effect.catchTag('ExtractionFailed', (err) =>
        onExtractionFailed(data.documentId, err),
      ),
      Effect.catchTag('BlobUnreadable', (err) =>
        onBlobUnreadable(data.documentId, err),
      ),
      Effect.catchTag(
        'StoreUnavailable',
        (err) =>
          new JobRetryable({
            reason: `document store unavailable during ${err.operation}: ${err.message}`,
          }),
      ),
    ),
}
