import { and, sql } from 'drizzle-orm'
import { isNumericType } from '@spaces/core/views/filter'
import type { SQL } from 'drizzle-orm'
import type { Condition } from '@spaces/core/views/filter'

/**
 * The second evaluator (SPA-40). `@spaces/core/views/filter` decides what a
 * view condition means over a loaded row in the browser; this module decides
 * the same thing in Postgres, so a list can be filtered before it is sent.
 * The semantics are not re-invented here — `filter.ts` owns them, including
 * the traps SQL gets wrong by default, and `sql.test.ts` walks every op
 * against every type over one shared fixture list to prove the two agree.
 *
 * It imports `sql` and `and` from drizzle and nothing else: no `db`, no
 * schema, no server module. That is what lets it travel with `views/store.ts`
 * in mono-8b while `filter.ts` and the fixtures go to core in mono-7, and it
 * is what makes `resolve` — one function argument — the whole surface seam.
 * An entity-backed list resolves a slug to its `values` member; a list whose
 * fields are real columns passes a resolver of its own and this file gains no
 * branch. `resolve` returning null (an unknown or archived attribute) drops
 * the condition rather than excluding every row, exactly as
 * `matchesConditions` skips a slug `typeOf` does not know.
 *
 * `expr` is the value as **jsonb**, not as text. `values->>'tags'` would hand
 * back `["a", "b"]` for a multi-select and "is a" would stop meaning "a is
 * among the values"; and a missing key, a stored JSON null and `''` would all
 * collapse into one another. Keeping it jsonb lets this module reproduce the
 * three JS coercions `filter.ts` leans on — `isEmpty`, `String(v)`,
 * `Number(v)` — rather than approximate them. A column-backed resolver wraps
 * its column in `to_jsonb(...)`; that is one call at the resolver, against a
 * branch per surface here.
 */

/** What one condition's slug resolves to on a given surface. */
export type ResolvedField = {
  /** The stored value as jsonb; SQL NULL when the field is absent. */
  expr: SQL
  /** The attribute type, as `opsFor`/`matchesCondition` spell it. */
  type: string
}

/** null means "this surface has no such live field" → the condition is ignored. */
export type FieldResolver = (slug: string) => ResolvedField | null

/** `filter.ts`'s `isEmpty`: null, undefined, `''`, `[]`. */
const empty = (j: SQL) => sql`(${j} is null
  or jsonb_typeof(${j}) = 'null'
  or ${j} = '""'::jsonb
  or ${j} = '[]'::jsonb)`

/**
 * JS `String(v)`. Scalars print themselves; an array prints its elements
 * joined by commas, with null printing as the empty string — that is
 * `Array.prototype.join`, and `contains` on a multi-select depends on it.
 */
const text = (j: SQL) => sql`(case
  when ${j} is null then null
  when jsonb_typeof(${j}) = 'null' then 'null'
  when jsonb_typeof(${j}) = 'array' then (
    select coalesce(
      string_agg(
        case when jsonb_typeof(e.value) = 'null' then '' else e.value #>> '{}' end,
        ',' order by e.ord),
      '')
    from jsonb_array_elements(${j}) with ordinality as e(value, ord))
  else ${j} #>> '{}'
end)`

/**
 * JS `Number(v)`, and never a cast that can throw: a non-numeric string is
 * NaN in the browser and SQL NULL here, so the row simply does not match.
 * `Number(null)` is 0, `Number(true)` is 1, `Number('  ')` is 0, and
 * `Number(v)` for anything else is `Number(String(v))` — which is why the
 * last two branches read the text form.
 */
const NUMERIC_TEXT = '^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?$'
const num = (j: SQL) => sql`(case
  when ${j} is null then null
  when jsonb_typeof(${j}) = 'null' then 0
  when jsonb_typeof(${j}) = 'boolean' then (case when ${j} = 'true'::jsonb then 1 else 0 end)
  when btrim(${text(j)}) = '' then 0
  when btrim(${text(j)}) ~ ${NUMERIC_TEXT} then btrim(${text(j)})::numeric
  else null
end)`

/** `filter.ts`'s `asList(v).some((x) => String(x) === lit)`. */
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
 * `filter.ts` answers "is the stored value empty?" first and returns a
 * constant when it is. That constant is known here, so the two branches
 * collapse into one predicate rather than a CASE.
 */
const orEmpty = (j: SQL, whenEmpty: boolean, otherwise: SQL) =>
  whenEmpty
    ? sql`(${empty(j)} or ${otherwise})`
    : sql`((not ${empty(j)}) and ${otherwise})`

function compileCondition(c: Condition, f: ResolvedField): SQL {
  const j = f.expr
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
      if (isNumericType(f.type)) {
        const b = Number(c.value)
        return orEmpty(
          j,
          !emptyValue(c.value),
          // NaN !== anything, so an unparseable target excludes nothing.
          Number.isFinite(b)
            ? sql`(${num(j)} is distinct from ${String(b)}::numeric)`
            : sql`true`,
        )
      }
      return orEmpty(
        j,
        !emptyValue(c.value),
        sql`(not ${someEquals(j, String(c.value))})`,
      )
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
 * One drizzle predicate for a whole condition list, ANDed — or undefined when
 * nothing survived, which is the caller's signal to add no `where` at all.
 *
 * Every condition is wrapped in `coalesce(…, false)` so SQL's third truth
 * value never leaks: `filter.ts` returns a boolean, and a row whose value did
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
