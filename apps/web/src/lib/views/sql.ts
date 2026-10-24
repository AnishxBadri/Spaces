import { and, sql } from 'drizzle-orm'
import { isNumericType } from '@spaces/core/views/filter'
import type { SQL } from 'drizzle-orm'
import type { Condition } from '@spaces/core/views/filter'

/**
 * View conditions compiled to Postgres, so a list is filtered before it is sent.
 * - Semantics belong to `@spaces/core/views/filter`; the sql tests run every op
 *   against every type over one fixture list to prove the two agree.
 * - Imports only `sql`/`and` from drizzle: no `db`, no schema. The `resolve`
 *   argument is the whole surface seam; a column-backed list passes its own.
 * - `resolve` returning null drops the condition rather than excluding every
 *   row, as `matchesConditions` skips an unknown slug.
 * - `expr` is jsonb, not text: `->>` would flatten a multi-select and merge a
 *   missing key, JSON null and `''`. Column resolvers wrap in `to_jsonb(...)`.
 */

/** An inverse attribute's links, built by the resolver so this module names no table. */
export type InverseLinks = {
  /** `exists` over the row's inbound links, narrowed to one source id when given. */
  exists: (member: string | null) => SQL
  /** The first referenced record's name: the inverse's sort key. */
  firstName: SQL
}

/** What one condition's slug resolves to on a given surface. */
export type ResolvedField = {
  /** The stored value as jsonb; SQL NULL when the field is absent. */
  expr: SQL
  /** The attribute type, as `opsFor`/`matchesCondition` spell it. */
  type: string
  /**
   * Set on an inverse attribute: membership ops compile to an `exists` over
   * its links rather than over `expr`, which still answers the rest.
   */
  inverse?: InverseLinks
}

/** null means "this surface has no such live field" → the condition is ignored. */
export type FieldResolver = (slug: string) => ResolvedField | null

/** The filter's `isEmpty`: null, undefined, `''`, `[]`. */
const empty = (j: SQL) => sql`(${j} is null
  or jsonb_typeof(${j}) = 'null'
  or ${j} = '""'::jsonb
  or ${j} = '[]'::jsonb)`

/**
 * JS `String(v)` as the IMMUTABLE SQL function `spaces_json_text(jsonb)`.
 * - An array prints its elements comma-joined, null as `''`
 *   (`Array.prototype.join`); `contains` on a multi-select depends on it.
 * - A function, not an inline CASE: the array branch is a subquery, which an
 *   index expression refuses, so only a function lets `attr_idx_*` match.
 */
const text = (j: SQL) => sql`spaces_json_text(${j})`

/**
 * JS `Number(v)` as `spaces_json_number(jsonb)`, for the same index reason.
 * - Never a cast that can throw: non-numeric is NaN in the browser, SQL NULL
 *   here, so the row does not match.
 * - `Number(null)` 0, `Number(true)` 1, `Number('  ')` 0; otherwise
 *   `Number(String(v))`, hence the function reads `spaces_json_text` back.
 */
const num = (j: SQL) => sql`spaces_json_number(${j})`

/** The filter's `asList(v).some((x) => String(x) === lit)`. */
const someEquals = (j: SQL, lit: string) => sql`(case
  when jsonb_typeof(${j}) = 'array' then exists (
    select 1 from jsonb_array_elements(${j}) as e(value)
    where (case when jsonb_typeof(e.value) = 'null' then 'null' else e.value #>> '{}' end) = ${lit})
  else ${text(j)} = ${lit}
end)`

/** JS truthiness, which is what `is` on a checkbox compares. */
const truthy = (j: SQL) => sql`(not (${j} is null
  or jsonb_typeof(${j}) = 'null'
  or ${j} = 'false'::jsonb
  or ${j} = '""'::jsonb
  or ${j} = '0'::jsonb))`

const FALSE = sql`false`

/** The client's `isEmpty`, evaluated at compile time on the condition value. */
const emptyValue = (v: Condition['value']) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0)

/**
 * The filter answers "is the stored value empty?" first and returns a
 * constant when it is. That constant is known here, so the two branches
 * collapse into one predicate rather than a CASE.
 */
const orEmpty = (j: SQL, whenEmpty: boolean, otherwise: SQL) =>
  whenEmpty
    ? sql`(${empty(j)} or ${otherwise})`
    : sql`((not ${empty(j)}) and ${otherwise})`

/**
 * Membership on an inverse, without building its list: the same answers
 * `orEmpty`/`someEquals` give over `expr`, since a source id is never `''`.
 */
function compileInverse(c: Condition, links: InverseLinks): SQL | null {
  switch (c.op) {
    case 'empty':
      return sql`(not ${links.exists(null)})`
    case 'not_empty':
      return links.exists(null)
    case 'is':
      return emptyValue(c.value)
        ? sql`(not ${links.exists(null)})`
        : links.exists(String(c.value))
    case 'is_not':
      return sql`(${links.exists(null)} and not ${links.exists(String(c.value))})`
    default:
      return null
  }
}

function compileCondition(c: Condition, f: ResolvedField): SQL {
  const j = f.expr
  const linked = f.inverse ? compileInverse(c, f.inverse) : null
  if (linked) return linked
  switch (c.op) {
    case 'empty':
      return empty(j)
    case 'not_empty':
      return sql`(not ${empty(j)})`
    case 'is': {
      // Checkbox compares truthiness, and does so before the empty check —
      // an absent key is `false`, not "no answer".
      if (f.type === 'checkbox')
        return c.value ? truthy(j) : sql`(not ${truthy(j)})`
      if (isNumericType(f.type)) {
        const b = Number(c.value)
        return orEmpty(
          j,
          emptyValue(c.value),
          Number.isFinite(b) ? sql`(${num(j)} = ${String(b)}::numeric)` : FALSE,
        )
      }
      return orEmpty(j, emptyValue(c.value), someEquals(j, String(c.value)))
    }
    case 'is_not': {
      // An empty stored value never matches "is not X", whatever X is.
      if (isNumericType(f.type)) {
        const b = Number(c.value)
        return orEmpty(
          j,
          false,
          // NaN !== anything, so an unparseable target excludes nothing.
          Number.isFinite(b)
            ? sql`(${num(j)} is distinct from ${String(b)}::numeric)`
            : sql`true`,
        )
      }
      return orEmpty(j, false, sql`(not ${someEquals(j, String(c.value))})`)
    }
    case 'contains': {
      const lit = String(c.value ?? '').toLowerCase()
      return sql`((not ${empty(j)}) and strpos(lower(${text(j)}), ${lit}) > 0)`
    }
    case 'gt':
    case 'lt': {
      if (emptyValue(c.value)) return FALSE
      const op = c.op === 'gt' ? sql`>` : sql`<`
      // Dates are ISO strings, so lexical order is chronological order.
      if (f.type === 'date')
        return sql`((not ${empty(j)}) and ${text(j)} ${op} ${String(c.value)})`
      const b = Number(c.value)
      if (!Number.isFinite(b)) return FALSE
      return sql`((not ${empty(j)}) and ${num(j)} ${op} ${String(b)}::numeric)`
    }
  }
}

/**
 * How the sort key must be cast on its way back out of a keyset cursor.
 * The cursor travels as text, so the comparison has to say what it is again.
 */
export type SortCast = 'text' | 'numeric'

/**
 * The sort key for a paged list: the same `String(v)`/`Number(v)` coercions
 * `gt`/`lt` use, so a column sorts the way "greater than" filters it.
 * - The `attr_idx_*` expression indexes must match this output exactly, or
 *   they sit unused with no error; the value-index-plan test is the EXPLAIN check.
 * - Dates are ISO strings, so `text` order is chronological.
 * - SQL NULL exactly when the key is absent, which `nulls last` sorts on.
 */
export function compileSortKey(f: ResolvedField): {
  expr: SQL
  cast: SortCast
} {
  // An inverse sorts by its first referenced name; its count sorts as the
  // `count:` field, which is numeric.
  if (f.inverse) return { expr: f.inverse.firstName, cast: 'text' }
  return isNumericType(f.type)
    ? { expr: num(f.expr), cast: 'numeric' }
    : { expr: text(f.expr), cast: 'text' }
}

/**
 * One drizzle predicate for a whole condition list, ANDed — or undefined when
 * nothing survived, which is the caller's signal to add no `where` at all.
 *
 * Every condition is wrapped in `coalesce(…, false)` so SQL's third truth
 * value never leaks: the filter returns a boolean, and a row whose value did
 * not parse must be excluded rather than left undecided.
 */
export function compileConditions(
  conditions: Array<Condition>,
  resolve: FieldResolver,
): SQL | undefined {
  const parts: Array<SQL> = []
  for (const c of conditions) {
    const field = resolve(c.slug)
    if (!field) continue
    parts.push(sql`coalesce(${compileCondition(c, field)}, false)`)
  }
  return parts.length === 0 ? undefined : and(...parts)
}
