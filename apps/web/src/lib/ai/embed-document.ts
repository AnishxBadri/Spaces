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
import type { StampWriteFailed } from '@spaces/core/writes/ai/stamp-sensitivity'

/**
 * A document's extracted text → its `chunk` rows. The worker's
 * `document.embed` job is this program; `extractDocument` enqueues it once
 * the text is stored.
 * - Runs with or without a pin: with none (`EmbeddingNotPinned`), or a
 *   sensitive document with no local route (`SensitiveRouteRefused`), the
 *   rows are written with null vectors for the lexical chunk lane.
 * - Any other embed failure still writes the chunks without vectors, then
 *   fails `EmbedDocumentFailed`, a permanent job failure: a re-extraction or
 *   backfill re-embeds, and a pg-boss retry would only cost.
 * - Re-running replaces, through `replaceChunks`; this is the reader.
 * - `model` is `embed()`'s test seam: only the wire is replaced.
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
