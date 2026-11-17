import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, link, note, objectDef } from '@spaces/db/schema'
import { canRead } from '@spaces/core/read-policy'

/**
 * A note's two mention lists for its rail: **Mentioned in**, the records
 * and notes whose body mentions it, and **Mentions**, what its own body
 * mentions. Both directions apply one rule: a private note the reader
 * cannot open drops out rather than leaking its title, and so does a
 * merged-away record.
 */

class NoteMentionsReadFailed extends Schema.TaggedError<NoteMentionsReadFailed>()(
  'NoteMentionsReadFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const read = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new NoteMentionsReadFailed({
        cause,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

// The object and the note kind ride along for the rail's kind icon and a
// custom record's route; visibility and author are read for `canRead` only.
const columns = {
  id: entity.id,
  name: entity.canonicalName,
  kind: entity.kind,
  objectSlug: objectDef.slug,
  objectLabel: objectDef.singular,
  objectIcon: objectDef.icon,
  noteKind: note.kind,
  visibility: note.visibility,
  authorId: note.authorId,
}

/** Both lists as `viewerId` may read them, each in the order it was written. */
export const noteMentionEdgesProgram = Effect.fn('noteMentionEdges')(function* (
  viewerId: string,
  noteId: string,
) {
  const viewer = { id: viewerId }
  const [inbound, outbound] = yield* Effect.all(
    [
      read(() =>
        db
          .select(columns)
          .from(link)
          .innerJoin(entity, eq(entity.id, link.fromEntityId))
          .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
          .leftJoin(note, eq(note.entityId, entity.id))
          .where(
            and(
              eq(link.toEntityId, noteId),
              eq(link.relation, 'mentions'),
              isNull(entity.mergedIntoId),
            ),
          )
          .orderBy(asc(link.createdAt)),
      ),
      read(() =>
        db
          .select(columns)
          .from(link)
          .innerJoin(entity, eq(entity.id, link.toEntityId))
          .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
          .leftJoin(note, eq(note.entityId, entity.id))
          .where(
            and(
              eq(link.fromEntityId, noteId),
              eq(link.relation, 'mentions'),
              isNull(entity.mergedIntoId),
            ),
          )
          .orderBy(asc(link.createdAt)),
      ),
    ],
    { concurrency: 'unbounded' },
  )
  const readable = (rows: typeof inbound) =>
    rows
      .filter((r) => canRead(viewer, r))
      .map(
        ({
          id,
          name,
          kind,
          objectSlug,
          objectLabel,
          objectIcon,
          noteKind,
        }) => ({
          id,
          name,
          kind,
          objectSlug,
          objectLabel,
          objectIcon,
          noteKind,
        }),
      )
  return {
    backlinks: readable(inbound).map(({ id, ...rest }) => ({
      fromId: id,
      ...rest,
    })),
    mentions: readable(outbound),
  }
})
