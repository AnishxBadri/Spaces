import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import type { EmbeddingModel } from 'ai'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'
import { chunk as cutChunks } from '@spaces/core/documents/chunk'
import { isEmbeddableAttribute } from '@spaces/core/writes/ai/chunk-sources'
import type { EmbedSource } from '@spaces/core/writes/ai/chunk-sources'
import { replaceChunks } from './embed-chunks'
import type { ReplaceChunksFailure } from './embed-chunks'

/**
 * A note's text or an embeddable attribute's value → its `chunk` rows
 * (SPA-132, ai-12b). The worker's `chunk.embed` job is this program;
 * `saveNoteProgram` and `setValuesEffect` enqueue it after their writes
 * commit (`./chunk-sources.ts`).
 *
 * This file only *reads* the source; the write is `replaceChunks`, the same
 * replace-stamp-embed transaction documents go through, so every rule there
 * holds here unchanged: rows land with null vectors when nothing is pinned
 * or the record is sensitive, a re-run replaces rather than appends, and an
 * empty text deletes the source's chunks.
 *
 * The text is read when the job runs, not when it was sent: a burst of note
 * autosaves coalesces into one queued job (`stately`), and whichever body is
 * current then is the one cut. A value cleared after the job was queued is
 * cut as empty, which deletes — the same answer the clear gave in its own
 * transaction.
 *
 * A private note is chunked like any other. Who may read its chunks is
 * decided where they are read — the semantic lane's `canReadNoteSql`, the
 * assembler's note filter — never by withholding the rows here.
 */

export type EmbedSourceInput = EmbedSource & { model?: EmbeddingModel }

export type EmbedSourceResult = {
  chunks: number
  embeddingModel: string | null
  /**
   * Why no vectors were made, when that was the designed outcome. `gone`:
   * the note or the record no longer exists, or the record was merged away
   * (its chunks followed the merge; the winner's value is the winner's).
   */
  skipped: 'no-pin' | 'sensitive' | 'gone' | null
}

export class EmbedSourceReadFailed extends Schema.TaggedError<EmbedSourceReadFailed>()(
  'EmbedSourceReadFailed',
  { cause: Schema.Defect() },
) {}

/** The job named an attribute that is not on `EMBEDDABLE_ATTRIBUTES`. */
export class NotEmbeddable extends Schema.TaggedError<NotEmbeddable>()(
  'NotEmbeddable',
  { kind: Schema.String, slug: Schema.String },
) {}

/** The chunks were written without vectors; this is why there are none. */
export class EmbedSourceFailed extends Schema.TaggedError<EmbedSourceFailed>()(
  'EmbedSourceFailed',
  {
    chunks: Schema.Number,
    /** The embed failure's tag, e.g. `CapExceeded`. */
    cause: Schema.String,
    /** `embedMessage`'s sentence for it. */
    reason: Schema.String,
  },
) {}

export type EmbedSourceFailure =
  | EmbedSourceReadFailed
  | EmbedSourceFailed
  | NotEmbeddable
  | ReplaceChunksFailure

/**
 * The editor appends the note's mentions as a last paragraph —
 * `Mentions: [[Acme|entity:<uuid>]] …` (`deriveMarkdown`,
 * `components/editor/note-editor.tsx`) — so the links survive a lossy
 * markdown export. It is bookkeeping, not prose: left in, every note that
 * mentions Acme would carry an `entity:` uuid into its vectors and read as
 * close to every other. Only a trailing block is cut, so a sentence that
 * happens to say "Mentions:" mid-note keeps its words.
 */
const MENTIONS_TRAILER = /(?:^|\n)[ \t]*Mentions:[^\n]*\s*$/

/** A note's text as it is chunked: the title, then the body's prose. */
export function noteEmbedText(title: string, bodyMd: string): string {
  const body = bodyMd.replace(MENTIONS_TRAILER, '').trim()
  return [title.trim(), body].filter((s) => s !== '').join('\n\n')
}

const read = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new EmbedSourceReadFailed({ cause }),
  })

/** The source's current text; `null` when the source no longer exists. */
const readText = Effect.fn('embedSource.readText')(function* (
  source: EmbedSource,
): Effect.fn.Return<string | null, EmbedSourceReadFailed | NotEmbeddable> {
  if (source.sourceKind === 'note') {
    const row = (yield* read(() =>
      db
        .select({ title: note.title, bodyMd: note.bodyMd })
        .from(note)
        .where(eq(note.entityId, source.entityId)),
    )).at(0)
    return row ? noteEmbedText(row.title, row.bodyMd) : null
  }
  const row = (yield* read(() =>
    db
      .select({
        kind: entity.kind,
        values: entity.values,
        mergedIntoId: entity.mergedIntoId,
      })
      .from(entity)
      .where(eq(entity.id, source.entityId)),
  )).at(0)
  if (!row || row.mergedIntoId !== null) return null
  if (!isEmbeddableAttribute(row.kind, source.sourceKey))
    return yield* new NotEmbeddable({
      kind: row.kind,
      slug: source.sourceKey,
    })
  const value = row.values[source.sourceKey]
  return typeof value === 'string' ? value.trim() : ''
})

export const embedSourceProgram = Effect.fn('embedSource')(function* (
  input: EmbedSourceInput,
): Effect.fn.Return<EmbedSourceResult, EmbedSourceFailure> {
  const { model, ...source } = input
  const text = yield* readText(source)
  if (text === null) return { chunks: 0, embeddingModel: null, skipped: 'gone' }

  const written = yield* replaceChunks(
    source,
    text === '' ? [] : cutChunks(text, 'text'),
    model === undefined ? {} : { model },
  )
  if (written.failure !== null)
    return yield* new EmbedSourceFailed({
      chunks: written.chunks,
      ...written.failure,
    })
  return {
    chunks: written.chunks,
    embeddingModel: written.embeddingModel,
    skipped: written.skipped,
  }
})
