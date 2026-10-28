import { Effect, Schema } from 'effect'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { user } from '@spaces/db/schema/auth'

/**
 * Archive and restore for an object record — a company, person, deal or
 * custom record. Archive takes it out of every list, search lane, the
 * context walk and Today; its own page still opens and Restore undoes it.
 * - Never a delete: links, filings, history and identity keys stay, so the
 *   resolver still finds the record and a re-import never mints a twin.
 * - A space is not a record here; it archives with its subtree on `space`.
 */

export class RecordNotFound extends Schema.TaggedError<RecordNotFound>()(
  'RecordNotFound',
  { id: Schema.String, message: Schema.String },
) {}

export class RecordArchiveFailed extends Schema.TaggedError<RecordArchiveFailed>()(
  'RecordArchiveFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RecordArchiveFailed({ cause }),
  })

const notFound = (id: string) =>
  new RecordNotFound({ id, message: 'Record not found' })

/** An unmerged object record: the only rows archive writes. */
const archivable = (id: string) =>
  and(
    eq(entity.id, id),
    isNotNull(entity.objectId),
    isNull(entity.mergedIntoId),
  )

/** When a record was archived and by whom; null while it is live. */
export type RecordArchive = { on: string; by: string | null }

export const recordArchiveProgram = Effect.fn('recordArchiveProgram')(
  function* (
    id: string,
  ): Effect.fn.Return<RecordArchive | null, RecordArchiveFailed> {
    const row = (yield* query(() =>
      db
        .select({ at: entity.archivedAt, by: user.name })
        .from(entity)
        .leftJoin(user, eq(user.id, entity.archivedBy))
        .where(eq(entity.id, id)),
    )).at(0)
    if (!row?.at) return null
    return { on: row.at.toISOString(), by: row.by }
  },
)

/**
 * Archive one record, asking nothing. Archiving an archived record answers
 * its existing archive and writes nothing.
 */
export const archiveRecordProgram = Effect.fn('archiveRecordProgram')(
  function* (
    actorId: string,
    id: string,
  ): Effect.fn.Return<RecordArchive, RecordNotFound | RecordArchiveFailed> {
    const head = (yield* query(() =>
      db.select({ at: entity.archivedAt }).from(entity).where(archivable(id)),
    )).at(0)
    if (!head) return yield* notFound(id)
    if (head.at === null) {
      yield* query(() =>
        db.transaction(async (tx) => {
          await tx
            .update(entity)
            .set({
              archivedAt: sql`date_trunc('milliseconds', now())`,
              archivedBy: actorId,
            })
            .where(and(archivable(id), isNull(entity.archivedAt)))
          await tx.insert(activity).values({
            actorId,
            verb: 'record.archived',
            subjectEntityId: id,
          })
        }),
      )
    }
    const now = yield* recordArchiveProgram(id)
    if (now === null) return yield* notFound(id)
    return now
  },
)

/** Restore one record to every list it left. A live record writes nothing. */
export const restoreRecordProgram = Effect.fn('restoreRecordProgram')(
  function* (
    actorId: string,
    id: string,
  ): Effect.fn.Return<
    { restored: boolean },
    RecordNotFound | RecordArchiveFailed
  > {
    const head = (yield* query(() =>
      db.select({ at: entity.archivedAt }).from(entity).where(archivable(id)),
    )).at(0)
    if (!head) return yield* notFound(id)
    if (head.at === null) return { restored: false }
    yield* query(() =>
      db.transaction(async (tx) => {
        await tx
          .update(entity)
          .set({ archivedAt: null, archivedBy: null })
          .where(archivable(id))
        await tx.insert(activity).values({
          actorId,
          verb: 'record.restored',
          subjectEntityId: id,
        })
      }),
    )
    return { restored: true }
  },
)

/** The words a refusal shows; anything unexpected reads as one line. */
export function recordArchiveMessage(failure: unknown): string {
  if (failure instanceof RecordNotFound) return failure.message
  return 'Could not change the record'
}
