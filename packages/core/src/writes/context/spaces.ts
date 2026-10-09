import { Effect } from 'effect'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { link, note, space } from '@spaces/db/schema'
import { ContextQueryFailed } from '../../context/errors'

/**
 * The space builders the assembler and the watch brief share: the live
 * ancestor chain of some spaces, and the memos tagged into them.
 * - `canRead` is applied in SQL: a note is readable when shared or the
 *   reader's own. An integration authors no note, so it reads shared only.
 * - Every fetch is ordered, so a caller's first-wins dedupe is stable.
 */

export const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ContextQueryFailed({ cause }),
  })

/** `canRead` as a SQL predicate over `note`, for one reader. */
export const readableNote = (readerId: string) =>
  or(eq(note.visibility, 'shared'), eq(note.authorId, readerId))

/**
 * Every live space at or above any of `paths`, root first. An archived
 * space leaves the chain; the filings that reached it stay.
 */
export const liveChainOf = (paths: ReadonlyArray<string>) =>
  query(() =>
    db
      .select({ id: space.entityId, path: space.path })
      .from(space)
      .where(
        and(
          or(...paths.map((p) => sql`${space.path} @> ${p}`)),
          isNull(space.archivedAt),
        ),
      )
      .orderBy(asc(space.path)),
  )

/** The memos tagged into these spaces that `readerId` may read. */
export const memosTaggedIn = (
  spaceIds: ReadonlyArray<string>,
  readerId: string,
) =>
  query(async () =>
    spaceIds.length === 0
      ? []
      : db
          .select({ spaceId: link.toEntityId, n: note })
          .from(link)
          .innerJoin(note, eq(note.entityId, link.fromEntityId))
          .where(
            and(
              inArray(link.toEntityId, [...spaceIds]),
              eq(link.relation, 'tagged_in'),
              eq(note.kind, 'memo'),
              readableNote(readerId),
            ),
          )
          .orderBy(asc(link.toEntityId), asc(note.entityId)),
  )
