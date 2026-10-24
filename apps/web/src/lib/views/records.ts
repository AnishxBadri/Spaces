import { Effect, Schema } from 'effect'
import { and, eq, ilike, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, entitySpace, link } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { compileConditions } from './sql'
import { entityValuesResolver } from './resolve'
import { inversesOf, lensRegistry, withInverseValues } from './inverse'
import { listScope } from './scope'
import {
  afterCursor,
  clampLimit,
  cutPage,
  decodeCursor,
  likeArg,
  orderByPage,
  planSort,
  sortKeyColumn,
} from './paging'
import type { ListPageOptions, RecordSort } from './paging'
import type { Condition } from '@spaces/core/views/filter'

/**
 * The registry list page's rows, filtered, sorted, counted and keyset-paged
 * in Postgres; the read `listObjectRecords` wraps.
 * - Kept out of the client-imported server-fns barrel, where a plain export
 *   would ship to the browser; tests call it directly.
 * - Archived attributes never reach the resolver, so their conditions drop.
 * - The text box is an `ILIKE` on `canonical_name`, not fused search: it
 *   narrows this table, while fused search ranks across kinds.
 */

export class RecordQueryFailed extends Schema.TaggedError<RecordQueryFailed>()(
  'RecordQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RecordQueryFailed({ cause }),
  })

/**
 * Re-exported so the shape of this surface's options reads at the call site;
 * the pager itself is `./paging`, shared with `/companies` and `/people`.
 */
export type { RecordSort }
export type ListRecordsOptions = ListPageOptions

export const listRecordsProgram = Effect.fn('listRecordsProgram')(function* (
  objectId: string,
  conditions: Array<Condition>,
  options: ListRecordsOptions = {},
) {
  // Live attributes only: an archived slug resolves to null and its
  // condition is dropped, the way `matchesConditions` skips an unknown one.
  const registry = (yield* query(() => lensRegistry(objectId))).live
  const resolve = entityValuesResolver(registry)
  const filter = compileConditions(conditions, resolve)
  const plan = planSort(options.sort, resolve)
  const limit = clampLimit(options.limit)
  const q = (options.q ?? '').trim()

  // Everything the reader asked for, cursor excluded: the page is a window
  // onto this set, and `total` is how big it is. Leaving the text box out of
  // the count would make the foot read "12 of 20,000" while twelve is the
  // whole truth — the box narrows, so it narrows the count too.
  const matching = and(
    listScope({ kind: 'custom', objectId }),
    filter,
    q ? ilike(entity.canonicalName, likeArg(q)) : undefined,
  )
  const cursor = options.cursor ? decodeCursor(options.cursor) : null

  const page = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        createdAt: entity.createdAt,
        // The key comes back as text so the cursor can carry it; the cast
        // back is the pager's job.
        sortKey: sortKeyColumn(plan),
      })
      .from(entity)
      .where(cursor ? and(matching, afterCursor(plan, cursor)) : matching)
      .orderBy(orderByPage(plan))
      // One more than asked: its existence is the only question, so it is
      // never returned. `nextCursor` null is what the foot reads as "end".
      .limit(limit + 1),
  )
  const counted = yield* query(() =>
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(entity)
      .where(matching),
  )
  const total = counted.at(0)?.total ?? 0

  const cut = cutPage(page, limit)
  const nextCursor = cut.nextCursor
  const inverse = yield* withInverseValues(cut.rows, inversesOf(registry)).pipe(
    Effect.mapError((e) => new RecordQueryFailed({ cause: e })),
  )
  const rows = inverse.rows

  const ids = rows.map((r) => r.id)
  const tags =
    ids.length > 0
      ? yield* query(() =>
          db
            .select({
              entityId: entitySpace.entityId,
              spaceId: entitySpace.spaceId,
              spaceName: entity.canonicalName,
            })
            .from(entitySpace)
            .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
            .where(inArray(entitySpace.entityId, ids)),
        )
      : []
  const spacesBy = new Map<string, Array<{ id: string; name: string }>>()
  for (const t of tags)
    spacesBy.set(t.entityId, [
      ...(spacesBy.get(t.entityId) ?? []),
      { id: t.spaceId, name: t.spaceName },
    ])
  // Names for record-reference values, so cells can render them.
  const refs =
    ids.length > 0
      ? yield* query(() =>
          db
            .select({ toId: link.toEntityId, name: entity.canonicalName })
            .from(link)
            .innerJoin(entity, eq(entity.id, link.toEntityId))
            .where(
              and(
                eq(link.relation, 'references'),
                inArray(link.fromEntityId, ids),
              ),
            ),
        )
      : []
  const users = yield* query(() =>
    db.select({ id: user.id, name: user.name }).from(user),
  )
  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      values: r.values,
      spaces: spacesBy.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
    total,
    refNames: {
      ...inverse.refNames,
      ...Object.fromEntries(refs.map((r) => [r.toId, { name: r.name }])),
      ...Object.fromEntries(users.map((u) => [u.id, { name: u.name }])),
    },
  }
})
