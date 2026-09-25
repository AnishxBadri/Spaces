import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import type { EmbeddingModel } from 'ai'
import { chunk } from '@spaces/db/schema'
import type { TextChunk } from '@spaces/core/documents/chunk'
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
 * The replace-stamp-embed half every chunk source shares (SPA-121 wrote it
 * for documents; SPA-132 lifted it out so notes and embeddable attributes
 * reuse it rather than growing a second writer). A caller cuts its text into
 * pieces; this embeds them and writes them in place of whatever the same
 * source held before.
 *
 * - **With or without a pin.** No pin (`EmbeddingNotPinned`) and a sensitive
 *   record with no local route (`SensitiveRouteRefused`) both write the rows
 *   with a null `embedding` and a null `embedding_model` — the designed
 *   outcome, reported in `skipped`. With the sensitive slot set (SPA-83),
 *   `embed()` routes a sensitive record's pieces to it and the rows carry
 *   the slot's model as `embedding_model`. Any other embed failure still writes the rows without
 *   vectors and comes back in `failure`, for the caller to turn into its own
 *   typed error.
 * - **Replace, never append.** The source's rows — `(entity_id, source_kind,
 *   source_key)` — are deleted and the new cut inserted in one transaction,
 *   the one `stampSensitivity` writes `sensitive` in. The unique index
 *   `(entity_id, source_kind, source_key, idx)` never sees two cuts, and no
 *   reader sees fresh rows unstamped. Zero pieces is a delete: a cleared
 *   attribute or an emptied note leaves no chunks behind.
 *
 * `model` is `embed()`'s test seam, passed straight through.
 */

/** Texts per `embed()` call — under every provider's per-request input cap. */
export const EMBED_BATCH = 96

export type ChunkSourceKind = (typeof chunk.$inferInsert)['sourceKind']

/** One source of chunks: an entity and the part of it the text came from. */
export type ChunkSource = {
  entityId: string
  sourceKind: ChunkSourceKind
  /** The attribute slug for `attribute`; `''` for a document or a note. */
  sourceKey: string
}

export type ChunksWritten = {
  chunks: number
  /** The pinned model the vectors came from; null when none were made. */
  embeddingModel: string | null
  /** Why no vectors were made, when that was the designed outcome. */
  skipped: 'no-pin' | 'sensitive' | null
  /** An undesigned embed failure: the rows were written without vectors. */
  failure: { cause: string; reason: string } | null
}

export type ReplaceChunksFailure =
  SensitivityReadFailed | SensitivityEntityNotFound | StampWriteFailed

type Vectors = {
  vectors: Array<Array<number>>
  model: string
}

/**
 * Every text through `embed()` in batches of EMBED_BATCH, all or nothing: a
 * failure in any batch leaves the whole source unembedded rather than
 * half-vectored, and is answered as a value so the chunks are still written.
 */
const embedAll = Effect.fn('embedChunks.embedAll')(function* (
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

export const replaceChunks = Effect.fn('replaceChunks')(function* (
  source: ChunkSource,
  pieces: ReadonlyArray<TextChunk>,
  opts: { model?: EmbeddingModel } = {},
): Effect.fn.Return<ChunksWritten, ReplaceChunksFailure> {
  const { entityId, sourceKind, sourceKey } = source

  // Live, as every egress boundary is: this answer decides what `embed()`
  // may send. `stampSensitivity` below reads it again for the column.
  const resolved = yield* sensitivityFor(entityId)

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
            ...(opts.model === undefined ? {} : { model: opts.model }),
          },
        )

  const vectors = embedded.ok
  const rows = pieces.map((p, i): typeof chunk.$inferInsert => ({
    entityId,
    sourceKind,
    sourceKey,
    idx: p.idx,
    text: p.text,
    page: p.page,
    embedding: vectors === null ? null : vectors.vectors[i],
    embeddingModel: vectors === null ? null : vectors.model,
  }))

  yield* stampSensitivity(entityId, {
    within: async (tx) => {
      await tx
        .delete(chunk)
        .where(
          and(
            eq(chunk.entityId, entityId),
            eq(chunk.sourceKind, sourceKind),
            eq(chunk.sourceKey, sourceKey),
          ),
        )
      if (rows.length > 0) await tx.insert(chunk).values(rows)
    },
  })

  const failure = embedded.failure
  if (failure === null)
    return {
      chunks: rows.length,
      embeddingModel: vectors === null ? null : vectors.model,
      skipped: null,
      failure: null,
    }
  switch (failure._tag) {
    case 'EmbeddingNotPinned':
      return {
        chunks: rows.length,
        embeddingModel: null,
        skipped: 'no-pin',
        failure: null,
      }
    case 'SensitiveRouteRefused':
      return {
        chunks: rows.length,
        embeddingModel: null,
        skipped: 'sensitive',
        failure: null,
      }
    default:
      return {
        chunks: rows.length,
        embeddingModel: null,
        skipped: null,
        failure: { cause: failure._tag, reason: embedMessage(failure) },
      }
  }
})
