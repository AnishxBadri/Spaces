import { sql } from 'drizzle-orm'
import { entity } from '@spaces/db/schema'
import { compileSortKey } from './sql'
import { RECORD_PAGE_MAX, RECORD_PAGE_SIZE } from './page-size'
import type { SQL } from 'drizzle-orm'
import type { FieldResolver, SortCast } from './sql'

/**
 * One keyset pager for every entity-backed list surface (SPA-64, extracted
 * SPA-96).
 *
 * `records.ts` grew these helpers for `/o/$objectSlug`; `/companies` and
 * `/people` take the same contract, so they live here rather than being
 * copied twice. **One cursor shape, one page size, one foot** — a second
 * spelling of "strictly after this row" is a bug waiting for the day the
 * two disagree about nulls.
 *
 * Every list that pages does so over `entity`: the sort key is a column of
 * it or a member of its `values` jsonb, and the tiebreaker is `entity.id`.
 * That is the whole assumption. What varies between surfaces — the `where`,
 * the joins, the side queries a page's ids need — stays with the surface.
 *
 * **Why keyset and not an offset.** A record born while someone is paging
 * shifts every offset after it by one, so a row is shown twice or never. A
 * cursor that names the last row's `(sort key, id)` cannot: the next page is
 * defined by where the reader stopped, not by how many rows precede them.
 */

/**
 * A sort as the table spells it: the column id, which is `name`,
 * `createdAt`, or `attr:<slug>`. The grid is the only caller and those ids
 * are its own, so the translation to a column or a `values` member lives
 * here rather than being re-derived on the client and sent as SQL-ish input.
 */
export type RecordSort = { id: string; desc: boolean }

/** What every paged list surface takes beyond its own conditions. */
export type ListPageOptions = {
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null
  /** Rows per page; clamped to `RECORD_PAGE_MAX`. */
  limit?: number
  /** The view's sort, or the header the reader clicked. */
  sort?: RecordSort | null
  /** The toolbar's text box. */
  q?: string
}

/** The default order, and the fallback for a sort key this surface has not got. */
const NEWEST_FIRST: RecordSort = { id: 'createdAt', desc: true }

export type SortPlan = {
  expr: SQL
  cast: SortCast | 'timestamptz'
  desc: boolean
}

/** A page's place in the order: the last row's sort key, and its id. */
export type PageCursor = { k: string | null; id: string }

/**
 * The table's column id, compiled to an `order by` expression over `entity`.
 * `name` and `createdAt` are columns; `attr:<slug>` goes through the same
 * `resolve` seam the conditions use, so an archived attribute drops its sort
 * exactly as it drops its condition — the list stays ordered, by the default
 * key. Anything this surface has no key for (`spaces`, `domains`,
 * `lastTouched`) falls back the same way; those columns disable their sort
 * menu rather than promising an order nobody can serve.
 */
export function planSort(
  sort: RecordSort | null | undefined,
  resolve: FieldResolver,
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
    const field = resolve(s.id.slice('attr:'.length))
    if (!field) return { ...created, desc: NEWEST_FIRST.desc }
    const key = compileSortKey(field)
    return { expr: key.expr, cast: key.cast, desc: s.desc }
  }
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
export function afterCursor(plan: SortPlan, cur: PageCursor): SQL {
  const cmp = plan.desc ? sql`<` : sql`>`
  if (cur.k === null)
    return sql`(${plan.expr} is null and ${entity.id} ${cmp} ${cur.id}::uuid)`
  const lit = keyLiteral(cur.k, plan.cast)
  return sql`((${plan.expr} ${cmp} ${lit})
    or (${plan.expr} = ${lit} and ${entity.id} ${cmp} ${cur.id}::uuid)
    or ${plan.expr} is null)`
}

/** The order the cursor was cut from — both halves, in both directions. */
export function orderByPage(plan: SortPlan): SQL {
  const dir = plan.desc ? sql`desc` : sql`asc`
  return sql`${plan.expr} ${dir} nulls last, ${entity.id} ${dir}`
}

/**
 * The sort key as text, selected alongside the row so the cursor can carry
 * it; `keyLiteral` casts it back on the way in.
 */
export const sortKeyColumn = (plan: SortPlan): SQL<string | null> =>
  sql<string | null>`(${plan.expr})::text`

export const encodeCursor = (c: PageCursor): string =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')

/** Opaque in, opaque out: an unreadable cursor is page one, never an error. */
export function decodeCursor(raw: string): PageCursor | null {
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

/** A hostile `limit` still costs one page's work, not the table. */
export const clampLimit = (limit?: number): number =>
  Math.max(1, Math.min(limit ?? RECORD_PAGE_SIZE, RECORD_PAGE_MAX))

/** `%`, `_` and `\` are LIKE syntax; a reader typing them means the characters. */
export const likeArg = (q: string) =>
  `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/**
 * The `limit + 1` convention, in one place: a surface asks Postgres for one
 * row more than the reader wanted, and the extra row's *existence* is the
 * only question — it is never returned. `nextCursor` null is what the foot
 * reads as "end".
 */
export function cutPage<T extends { id: string; sortKey: string | null }>(
  page: Array<T>,
  limit: number,
): { rows: Array<T>; nextCursor: string | null } {
  const rows = page.slice(0, limit)
  const last = rows.at(-1)
  return {
    rows,
    nextCursor:
      page.length > limit && last
        ? encodeCursor({ k: last.sortKey, id: last.id })
        : null,
  }
}
