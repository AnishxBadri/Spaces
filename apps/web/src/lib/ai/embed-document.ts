import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import type { EmbeddingModel } from 'ai'
import { db } from '@spaces/db'
import { chunk, document } from '@spaces/db/schema'
import { chunk as cutChunks } from '@spaces/core/documents/chunk'
import { detectFormat } from '@spaces/core/documents/extract'
import { embedMessage, embedProgram } from './embed'
import type { EmbedFailure, EmbedOptions } from './embed'
import { sensitivityFor } from './sensitivity-for'
import type {
  SensitivityEntityNotFound,
  SensitivityReadFailed,
} from './sensitivity-for'
import { stampSensitivity } from './stamp-sensitivity'
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
 * reader ever sees the new rows unstamped.
 *
 * `model` is the test seam, passed straight through to `embed()`: the pin
 * is still read and every check still applies; only the wire is replaced.
 */

/** Texts per `embed()` call — under every provider's per-request input cap. */
export const EMBED_BATCH = 96

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

type Vectors = {
  vectors: Array<Array<number>>
  model: string
}

/**
 * Every text through `embed()` in batches of EMBED_BATCH, all or nothing: a
 * failure in any batch leaves the whole document unembedded rather than
 * half-vectored, and is answered as a value so the chunks are still written.
 */
const embedAll = Effect.fn('embedDocument.embedAll')(function* (
  texts: ReadonlyArray<string>,
  opts: Pick<EmbedOptions, 'sensitivity' | 'via' | 'model'>,
): Effect.fn.Return<{ ok: Vectors | null; failure: EmbedFailure | null }> {
  const vectors: Array<Array<number>> = []
  let model: string | null = null
  for (let at = 0; at < texts.length; at += EMBED_BATCH) {
    const r = yield* Effect.result(
      embedProgram(texts.slice(at, at + EMBED_BATCH), {
        caller: { type: 'system' },
        ...opts,
      }),
    )
    if (r._tag === 'Failure') return { ok: null, failure: r.failure }
    vectors.push(...r.success.vectors)
    model = r.success.target.model
  }
  return model === null
    ? { ok: null, failure: null }
    : { ok: { vectors, model }, failure: null }
})

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
  const pieces = cutChunks(row.text, format)

  // Live, as every egress boundary is: this answer decides what `embed()`
  // may send. `stampSensitivity` below reads it again for the column.
  const resolved = yield* sensitivityFor(documentId)

  const embedded: { ok: Vectors | null; failure: EmbedFailure | null } =
    pieces.length === 0
      ? { ok: null, failure: null }
      : yield* embedAll(
          pieces.map((p) => p.text),
          {
            sensitivity: resolved.sensitivity,
            ...(resolved.sensitivity === 'sensitive'
              ? { via: resolved.via }
              : {}),
            ...(input.model === undefined ? {} : { model: input.model }),
          },
        )

  const vectors = embedded.ok
  const rows = pieces.map((p, i): typeof chunk.$inferInsert => ({
    entityId: documentId,
    sourceKind: 'document',
    sourceKey: '',
    idx: p.idx,
    text: p.text,
    page: p.page,
    embedding: vectors === null ? null : vectors.vectors[i],
    embeddingModel: vectors === null ? null : vectors.model,
  }))

  yield* stampSensitivity(documentId, {
    within: async (tx) => {
      await tx
        .delete(chunk)
        .where(
          and(eq(chunk.entityId, documentId), eq(chunk.sourceKind, 'document')),
        )
      if (rows.length > 0) await tx.insert(chunk).values(rows)
    },
  })

  const failure = embedded.failure
  if (failure !== null) {
    switch (failure._tag) {
      case 'EmbeddingNotPinned':
        return { chunks: rows.length, embeddingModel: null, skipped: 'no-pin' }
      case 'SensitiveRouteRefused':
        return {
          chunks: rows.length,
          embeddingModel: null,
          skipped: 'sensitive',
        }
      default:
        return yield* new EmbedDocumentFailed({
          chunks: rows.length,
          cause: failure._tag,
          reason: embedMessage(failure),
        })
    }
  }
  return {
    chunks: rows.length,
    embeddingModel: vectors === null ? null : vectors.model,
    skipped: null,
  }
})
