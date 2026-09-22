import { Effect, Schema } from 'effect'
import { and, eq, ilike, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { attribute, entity, entitySpace, link } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { compileConditions, compileSortKey } from './sql'
import { entityValuesResolver } from './resolve'
import { RECORD_PAGE_MAX, RECORD_PAGE_SIZE } from './page-size'
import type { SQL } from 'drizzle-orm'
import type { SortCast } from './sql'
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
 * A sort as the table spells it: the column id, which is `name`,
 * `createdAt`, or `attr:<slug>`. The grid is the only caller and those ids
 * are its own, so the translation to a column or a `values` member lives
 * here rather than being re-derived on the client and sent as SQL-ish input.
 */
export type RecordSort = { id: string; desc: boolean }

export type ListRecordsOptions = {
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null
  /** Rows per page; clamped to `RECORD_PAGE_MAX`. */
  limit?: number
  /** The view's sort, or the header the reader clicked. */
  sort?: RecordSort | null
  /** The toolbar's text box — `ILIKE '%q%'` on `canonical_name`. */
  q?: string
}

/** The default order, and the fallback for a sort key this surface has not got. */
const NEWEST_FIRST: RecordSort = { id: 'createdAt', desc: true }

type SortPlan = { expr: SQL; cast: SortCast | 'timestamptz'; desc: boolean }

/** A page's place in the order: the last row's sort key, and its id. */
type PageCursor = { k: string | null; id: string }

function planSort(
  sort: RecordSort | null | undefined,
  resolve: ReturnType<typeof entityValuesResolver>,
): SortPlan {
  const s = sort ?? NEWEST_FIRST
  const created: SortPlan = {
    expr: sql`${entity.createdAt}`,
    cast: 'timestamptz',
    desc: s.desc,
  }
  if (s.id === 'name')
    return { expr: sql`${entity.canonicalName}`, cast: 'text', desc: s.desc }
  if (s.id.startsWith('attr:')) {
    // An archived or unknown attribute drops its sort the way it drops its
    // condition: the list is still ordered, just by the default key.
    const field = resolve(s.id.slice('attr:'.length))
    if (!field) return { ...created, desc: NEWEST_FIRST.desc }
    const key = compileSortKey(field)
    return { expr: key.expr, cast: key.cast, desc: s.desc }
  }
  // `createdAt`, and anything the server has no key for (`spaces`).
  return s.id === 'createdAt'
    ? created
    : { ...created, desc: NEWEST_FIRST.desc }
}

/** The cursor's `k`, cast back to the type the order by compares. */
const keyLiteral = (k: string, cast: SortPlan['cast']): SQL =>
  cast === 'numeric'
    ? sql`${k}::numeric`
    : cast === 'timestamptz'
      ? sql`${k}::timestamptz`
      : sql`${k}::text`

/**
 * "Strictly after the cursor, in this order." Null keys sort last in both
 * directions, so a cursor whose key is null has already passed every
 * non-null row and only `id` is left to break the tie; a cursor with a key
 * has not reached the null tail yet, which is why `is null` is an
 * alternative rather than an exclusion.
 */
function afterCursor(plan: SortPlan, cur: PageCursor): SQL {
  const cmp = plan.desc ? sql`<` : sql`>`
  if (cur.k === null)
    return sql`(${plan.expr} is null and ${entity.id} ${cmp} ${cur.id}::uuid)`
  const lit = keyLiteral(cur.k, plan.cast)
  return sql`((${plan.expr} ${cmp} ${lit})
    or (${plan.expr} = ${lit} and ${entity.id} ${cmp} ${cur.id}::uuid)
    or ${plan.expr} is null)`
}

const encodeCursor = (c: PageCursor): string =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')

/** Opaque in, opaque out: an unreadable cursor is page one, never an error. */
function decodeCursor(raw: string): PageCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  if (!('id' in parsed) || !('k' in parsed)) return null
  const { id, k } = parsed
  if (typeof id !== 'string' || id === '') return null
  if (k !== null && typeof k !== 'string') return null
  return { id, k }
}

/** `%`, `_` and `\` are LIKE syntax; a reader typing them means the characters. */
const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

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
  const limit = Math.max(
    1,
    Math.min(options.limit ?? RECORD_PAGE_SIZE, RECORD_PAGE_MAX),
  )
  const q = (options.q ?? '').trim()

  // Everything the reader asked for, cursor excluded: the page is a window
  // onto this set, and `total` is how big it is. Leaving the text box out of
  // the count would make the foot read "12 of 20,000" while twelve is the
  // whole truth — the box narrows, so it narrows the count too.
  const matching = and(
    eq(entity.objectId, objectId),
    eq(entity.kind, 'custom'),
    isNull(entity.mergedIntoId),
    filter,
    q ? ilike(entity.canonicalName, likeArg(q)) : undefined,
  )
  const cursor = options.cursor ? decodeCursor(options.cursor) : null
  const dir = plan.desc ? sql`desc` : sql`asc`

  const page = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        createdAt: entity.createdAt,
        // The key comes back as text so the cursor can carry it; the cast
        // back is `keyLiteral`'s job.
        sortKey: sql<string | null>`(${plan.expr})::text`,
      })
      .from(entity)
      .where(cursor ? and(matching, afterCursor(plan, cursor)) : matching)
      .orderBy(sql`${plan.expr} ${dir} nulls last, ${entity.id} ${dir}`)
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

  const rows = page.slice(0, limit)
  const last = rows.at(-1)
  const nextCursor =
    page.length > limit && last
      ? encodeCursor({ k: last.sortKey, id: last.id })
      : null

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
