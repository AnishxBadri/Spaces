import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import type { EmbeddingModel } from 'ai'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { chunk as cutChunks } from '@spaces/core/documents/chunk'
import { detectFormat } from '@spaces/core/documents/extract'
import { replaceChunks } from './embed-chunks'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'
import type { StampWriteFailed } from './stamp-sensitivity'

/**
 * A document's extracted text → its `chunk` rows (SPA-121, ai-10b;
 * docs/spec-ai-substrate.md §9). The worker's `document.embed` job is this
 * program; `extractDocument` enqueues it once the text is stored.
 *
 * **It runs with or without a pin.** The cut is `chunk()` from
 * `@spaces/core/documents/chunk`, pure; the vectors are `embed()`'s. With no
 * embedding model pinned, `embed()` fails `EmbeddingNotPinned` and the rows
 * are written anyway with a null `embedding` and a null `embedding_model` —
 * which is what the assembler's lexical chunk lane reads, so a keyless
 * install's Context readout still cites a document by its chunks. A sensitive document is the same
 * story by policy (`SensitiveRouteRefused`: skip, never leak): chunked for
 * the lexical lane, left unembedded until a local model exists.
 *
 * Any other embed failure (a cap, a missing key, a provider down, a wrong
 * width) still writes the chunks without vectors — the lexical lane should
 * not wait on a provider — and then fails `EmbedDocumentFailed`, which the
 * job turns into a permanent failure carrying `embedMessage`'s sentence. A
 * re-extraction or a later backfill re-embeds; pg-boss retrying a model call
 * is a cost with the same answer.
 *
 * Re-running replaces: the document's `source_kind: 'document'` rows are
 * deleted and the new cut inserted in one transaction, the same transaction
 * `stampSensitivity` writes `sensitive` in — so the unique index
 * `(entity_id, source_kind, source_key, idx)` never sees two cuts, and no
 * reader ever sees the new rows unstamped. That half is `replaceChunks`
 * (`./embed-chunks.ts`), shared since SPA-132 with notes and embeddable
 * attributes (`./embed-source.ts`); this file is the document's reader.
 *
 * `model` is the test seam, passed straight through to `embed()`: the pin
 * is still read and every check still applies; only the wire is replaced.
 */

export { EMBED_BATCH } from './embed-chunks'

export type EmbedDocumentInput = {
  documentId: string
  model?: EmbeddingModel
}

export type EmbedDocumentResult = {
  chunks: number
  /** The pinned model the vectors came from; null when none were made. */
  embeddingModel: string | null
  /** Why no vectors were made, when that was the designed outcome. */
  skipped: 'no-pin' | 'sensitive' | 'no-text' | null
}

export class EmbedDocumentReadFailed extends Schema.TaggedError<EmbedDocumentReadFailed>()(
  'EmbedDocumentReadFailed',
  { cause: Schema.Defect() },
) {}

/** The chunks were written without vectors; this is why there are none. */
export class EmbedDocumentFailed extends Schema.TaggedError<EmbedDocumentFailed>()(
  'EmbedDocumentFailed',
  {
    chunks: Schema.Number,
    /** The embed failure's tag, e.g. `CapExceeded`. */
    cause: Schema.String,
    /** `embedMessage`'s sentence for it. */
    reason: Schema.String,
  },
) {}

export type EmbedDocumentFailure =
  | EmbedDocumentReadFailed
  | EmbedDocumentFailed
  | SensitivityReadFailed
  | SensitivityEntityNotFound
  | StampWriteFailed

export const embedDocumentProgram = Effect.fn('embedDocument')(function* (
  input: EmbedDocumentInput,
): Effect.fn.Return<EmbedDocumentResult, EmbedDocumentFailure> {
  const { documentId } = input
  const row = (yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          text: document.extractedText,
          filename: document.filename,
          mime: document.mime,
        })
        .from(document)
        .where(eq(document.entityId, documentId)),
    catch: (cause) => new EmbedDocumentReadFailed({ cause }),
  })).at(0)
  if (!row || row.text === null || row.text.trim() === '')
    return { chunks: 0, embeddingModel: null, skipped: 'no-text' }

  const format = detectFormat(row.filename, row.mime) ?? 'text'
  const written = yield* replaceChunks(
    { entityId: documentId, sourceKind: 'document', sourceKey: '' },
    cutChunks(row.text, format),
    input.model === undefined ? {} : { model: input.model },
  )
  if (written.failure !== null)
    return yield* new EmbedDocumentFailed({
      chunks: written.chunks,
      ...written.failure,
    })
  return {
    chunks: written.chunks,
    embeddingModel: written.embeddingModel,
    skipped: written.skipped,
  }
})
