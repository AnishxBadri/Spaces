import { Readable } from 'node:stream'
import { Effect, Schema } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, pendingBlob } from '@spaces/db/schema'
import { PICTURE_MAX_BYTES, judgePicture } from '../../enrichment/picture'
import { putBlobProgram } from '../documents/intake'

/**
 * A person sets or clears a record's picture by hand (D76).
 * - Either write marks the picture held: enrichment never fills it again.
 * - Answers the digest it replaced, so the caller can reclaim those bytes
 *   once no row names them (`reclaimBlobIfOrphaned`).
 * - Only a company or a person carries a picture.
 */

export class PictureRefused extends Schema.TaggedError<PictureRefused>()(
  'PictureRefused',
  { message: Schema.String },
) {}

export class PictureWriteFailed extends Schema.TaggedError<PictureWriteFailed>()(
  'PictureWriteFailed',
  { cause: Schema.Defect() },
) {}

const io = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PictureWriteFailed({ cause }),
  })

const PICTURED = ['company', 'person'] as const

/** Writes `sha` (or null) under the row lock; the previous digest, or a refusal. */
const writePicture = (entityId: string, sha: string | null) =>
  io(() =>
    db.transaction(async (tx) => {
      const row = (
        await tx
          .select({ pictureSha: entity.pictureSha })
          .from(entity)
          .where(and(eq(entity.id, entityId), inArray(entity.kind, PICTURED)))
          .for('update')
      ).at(0)
      if (row === undefined) return { found: false as const }
      await tx
        .update(entity)
        .set({ pictureSha: sha, pictureHeld: true })
        .where(eq(entity.id, entityId))
      if (sha !== null)
        await tx.delete(pendingBlob).where(eq(pendingBlob.sha, sha))
      return { found: true as const, previous: row.pictureSha }
    }),
  ).pipe(
    Effect.flatMap((r) =>
      r.found
        ? Effect.succeed({
            previous: r.previous === sha ? null : r.previous,
          })
        : Effect.fail(
            new PictureRefused({
              message: 'Only a company or a person has a picture',
            }),
          ),
    ),
  )

export const setPictureProgram = Effect.fn('setPicture')(function* (input: {
  readonly entityId: string
  readonly bytes: Uint8Array
  readonly contentType: string | null
  readonly by: string
}): Effect.fn.Return<
  { readonly sha: string; readonly previous: string | null },
  PictureRefused | PictureWriteFailed
> {
  const judged = judgePicture(input.contentType, input.bytes)
  if (!judged.ok)
    return yield* new PictureRefused({
      message:
        judged.why === 'too large'
          ? `The picture is larger than ${String(PICTURE_MAX_BYTES / 1024 / 1024)} MB`
          : 'Choose a PNG, JPEG, GIF or WebP image',
    })
  const { sha } = yield* putBlobProgram({
    stream: Readable.from(Buffer.from(input.bytes)),
    mime: judged.type,
    preparedBy: input.by,
  }).pipe(Effect.mapError((cause) => new PictureWriteFailed({ cause })))
  const { previous } = yield* writePicture(input.entityId, sha)
  return { sha, previous }
})

export const clearPictureProgram = Effect.fn('clearPicture')(function* (
  entityId: string,
): Effect.fn.Return<
  { readonly previous: string | null },
  PictureRefused | PictureWriteFailed
> {
  return yield* writePicture(entityId, null)
})
