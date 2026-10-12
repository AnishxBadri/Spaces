import { Effect } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, link, note } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { canRead } from '@spaces/core/read-policy'
import { raiseSensitivity } from '@spaces/core/writes/ai/stamp-sensitivity'
import { noteSource } from '@spaces/core/writes/ai/chunk-sources'
import { insertSupersedes } from '@spaces/core/writes/links/supersedes'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import { NoteNotFound, NoteQueryFailed } from '#/lib/notes/delete'

/**
 * "Save as new version" on a note: a new note that supersedes the old. (D59)
 * - The copy carries the title, kind, visibility and body, its mentions, and
 *   every filing — the records it is filed against and its spaces.
 * - The old note is untouched: it stays readable and searchable, ranked lower.
 * - The edge goes through `insertSupersedes`, the one `supersedes` writer.
 */

/** The sentence the client is shown; a `Schema.TaggedError` carries none. */
export function noteVersionMessage(failure: unknown): string {
  if (failure instanceof NoteNotFound) return 'Note not found'
  return 'Could not save a new version'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new NoteQueryFailed({ cause }),
  })

export const saveNoteAsNewVersionProgram = Effect.fn(
  'saveNoteAsNewVersionProgram',
)(function* (
  userId: string,
  oldId: string,
): Effect.fn.Return<{ id: string }, NoteNotFound | NoteQueryFailed> {
  const old = (yield* query(() =>
    db
      .select({
        title: note.title,
        kind: note.kind,
        bodyJson: note.bodyJson,
        bodyMd: note.bodyMd,
        visibility: note.visibility,
        authorId: note.authorId,
      })
      .from(note)
      .where(eq(note.entityId, oldId)),
  )).at(0)
  if (!old || !canRead({ id: userId }, old))
    return yield* new NoteNotFound({ id: oldId })

  const born = yield* query(() =>
    db.transaction(async (tx) => {
      const ent = (
        await tx
          .insert(entity)
          .values({
            kind: 'note',
            canonicalName: old.title || 'Untitled',
            createdBy: userId,
          })
          .returning({ id: entity.id })
      ).at(0)
      if (!ent) throw new Error('note entity insert returned no row')

      await tx.insert(note).values({
        entityId: ent.id,
        authorId: userId,
        title: old.title,
        kind: old.kind,
        bodyJson: old.bodyJson,
        bodyMd: old.bodyMd,
        visibility: old.visibility,
      })

      // Filed where the old one is, and mentioning what it mentions — the
      // body is the same, so its extracted edges are too.
      const edges = await tx
        .select({
          toEntityId: link.toEntityId,
          relation: link.relation,
          source: link.source,
        })
        .from(link)
        .where(
          and(
            eq(link.fromEntityId, oldId),
            inArray(link.relation, ['tagged_in', 'mentions']),
          ),
        )
      if (edges.length > 0)
        await tx
          .insert(link)
          .values(
            edges.map((e) => ({
              fromEntityId: ent.id,
              toEntityId: e.toEntityId,
              relation: e.relation,
              source: e.source,
              createdBy: userId,
            })),
          )
          .onConflictDoNothing()

      const spaces = await tx
        .select({ spaceId: entitySpace.spaceId })
        .from(entitySpace)
        .where(eq(entitySpace.entityId, oldId))
      for (const { spaceId } of spaces) {
        await tx
          .insert(entitySpace)
          .values({
            entityId: ent.id,
            spaceId,
            source: 'manual',
            createdBy: userId,
          })
          .onConflictDoNothing()
        await raiseSensitivity(tx, {
          kind: 'filed',
          entityId: ent.id,
          spaceId,
        })
      }

      await insertSupersedes(tx, {
        newerId: ent.id,
        olderId: oldId,
        actorId: userId,
      })

      await tx.insert(activity).values({
        actorId: userId,
        verb: 'note.created',
        subjectEntityId: ent.id,
      })
      return { id: ent.id }
    }),
  )

  yield* Effect.promise(() => enqueueSourceEmbed(noteSource(born.id)))
  return born
})
