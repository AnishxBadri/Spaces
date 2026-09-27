import { Effect, Schema } from 'effect'
import { and, eq, ilike, inArray, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, entity, entitySpace, link } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { compileConditions } from './sql'
import { entityValuesResolver } from './resolve'
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
 * The registry-generated list page's rows, filtered, sorted, counted and
 * **paged** in Postgres (SPA-40, then SPA-64).
 *
 * This is the read `listObjectRecords` wraps. It lives outside
 * `lib/server/` on purpose: `lib/server-fns.ts` is a client-imported barrel
 * and re-exports `server/objects.ts`, so a plain export from there ships to
 * the browser — only `createServerFn().handler()` bodies are stripped
 * (CLAUDE.md, traps). A test that wants the query without a request calls
 * this program directly.
 *
 * The live registry read is what makes an archived attribute *ignorable*
 * rather than exclusionary: it never reaches the resolver, so its condition
 * is dropped and the list widens.
 *
 * **Why keyset and not an offset.** This is the surface the CSV import area
 * floods first, and a record born while someone is paging shifts every
 * offset after it by one — a row is shown twice or never. A cursor that
 * names the last row's `(sort key, id)` cannot: the next page is defined by
 * where the reader stopped, not by how many rows happen to precede it.
 *
 * **Why the text box is a server ILIKE and not Cmd-K.** The other half of
 * the choice was to delete the box and let the palette do it. The palette is
 * fused search across every kind — it answers "where is Acme", one hit at a
 * time, and it leaves this table alone. The box answers "narrow *this*
 * table", keeps the rows in the grid with their columns and their sort, and
 * composes with the view's conditions. Those are different questions, so the
 * box stays and becomes an `ILIKE` on `canonical_name` sent with the
 * request. Deliberately *not* wired into `lib/server/search.ts`'s fused CTE:
 * that query is being rewritten by three other slices, and it ranks across
 * kinds, which is exactly what this surface does not want.
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
 * the pager itself is `./paging`, shared with `/companies` and `/people`
 * (SPA-96).
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
  const registry = yield* query(() =>
    db
      .select({ slug: attribute.slug, type: attribute.type })
      .from(attribute)
      .where(
        and(eq(attribute.objectId, objectId), eq(attribute.archived, false)),
      ),
  )
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

  const { rows, nextCursor } = cutPage(page, limit)

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
      ...Object.fromEntries(refs.map((r) => [r.toId, { name: r.name }])),
      ...Object.fromEntries(users.map((u) => [u.id, { name: u.name }])),
    },
  }
})
