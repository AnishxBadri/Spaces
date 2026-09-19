import type {
  Condition,
  ConditionOp,
  ConditionValue,
  ViewExtra,
  ViewSort,
} from '@spaces/db/schema/views'

/**
 * The view filter model — pure, client-safe. Conditions are ANDed and
 * evaluated over loaded rows (tables are not paginated). Ops are typed by
 * attribute so the editor only offers what makes sense: a select is
 * `is`/`is_not`, a number is `gt`/`lt`, everything can be `empty`.
 *
 * The shapes themselves are declared at the `view` table's jsonb columns
 * (`@spaces/db/schema/views`) and re-exported here, so every `#/lib/views/filter`
 * import reads the same names it always did (SPA-142). This module is the
 * behaviour: the op menu, the matcher, the coercions.
 */
export type { Condition, ConditionOp, ConditionValue, ViewExtra, ViewSort }

const OPS: Array<ConditionOp> = [
  'is',
  'is_not',
  'contains',
  'empty',
  'not_empty',
  'gt',
  'lt',
]

/** A `<select>`'s string back to an op, or null if it names none. */
export function toConditionOp(v: string): ConditionOp | null {
  return OPS.find((op) => op === v) ?? null
}

/** An editor's value narrowed to what a condition may compare against. */
export function toConditionValue(v: unknown): ConditionValue {
  if (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  )
    return v
  return Array.isArray(v) ? v.map(String) : null
}

export const OP_LABELS: Record<ConditionOp, string> = {
  is: 'is',
  is_not: 'is not',
  contains: 'contains',
  empty: 'is empty',
  not_empty: 'is not empty',
  gt: 'is more than',
  lt: 'is less than',
}

const TEXT_TYPES = new Set(['text', 'url', 'email', 'phone', 'domain'])
const NUMBER_TYPES = new Set(['number', 'currency', 'rating'])
const OPTION_TYPES = new Set(['select', 'status', 'multi_select'])
const REF_TYPES = new Set(['record_reference', 'actor_reference'])

/** Which ops an attribute type supports, in menu order. */
export function opsFor(type: string): Array<ConditionOp> {
  if (TEXT_TYPES.has(type))
    return ['contains', 'is', 'is_not', 'empty', 'not_empty']
  if (NUMBER_TYPES.has(type)) return ['is', 'gt', 'lt', 'empty', 'not_empty']
  if (type === 'date') return ['is', 'gt', 'lt', 'empty', 'not_empty']
  if (type === 'checkbox') return ['is']
  if (OPTION_TYPES.has(type) || REF_TYPES.has(type))
    return ['is', 'is_not', 'empty', 'not_empty']
  return ['is', 'is_not', 'empty', 'not_empty']
}

/** Ops that take no value. */
export const isUnary = (op: ConditionOp) => op === 'empty' || op === 'not_empty'

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && v.length === 0)

const asList = (v: unknown): Array<unknown> =>
  Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]

/** One row's values against one condition. Unknown ops never match. */
export function matchesCondition(
  values: Record<string, unknown>,
  c: Condition,
  type: string,
): boolean {
  const v = values[c.slug]
  switch (c.op) {
    case 'empty':
      return isEmpty(v)
    case 'not_empty':
      return !isEmpty(v)
    case 'is': {
      if (type === 'checkbox') return Boolean(v) === Boolean(c.value)
      if (isEmpty(v)) return isEmpty(c.value)
      if (NUMBER_TYPES.has(type)) return Number(v) === Number(c.value)
      // Multi-valued: "is X" means X is among the values.
      return asList(v).some((x) => String(x) === String(c.value))
    }
    case 'is_not': {
      if (isEmpty(v)) return !isEmpty(c.value)
      if (NUMBER_TYPES.has(type)) return Number(v) !== Number(c.value)
      return !asList(v).some((x) => String(x) === String(c.value))
    }
    case 'contains':
      return (
        !isEmpty(v) &&
        String(v)
          .toLowerCase()
          .includes(String(c.value ?? '').toLowerCase())
      )
    case 'gt':
    case 'lt': {
      if (isEmpty(v) || isEmpty(c.value)) return false
      // Dates are ISO strings, so lexical order is chronological order.
      if (type === 'date')
        return c.op === 'gt'
          ? String(v) > String(c.value)
          : String(v) < String(c.value)
      const a = Number(v)
      const b = Number(c.value)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      return c.op === 'gt' ? a > b : a < b
    }
    default:
      return false
  }
}

/** All conditions must hold. A condition on an unknown attribute is ignored. */
export function matchesConditions(
  values: Record<string, unknown>,
  conditions: Array<Condition>,
  typeOf: (slug: string) => string | undefined,
): boolean {
  for (const c of conditions) {
    const type = typeOf(c.slug)
    if (!type) continue
    if (!matchesCondition(values, c, type)) return false
  }
  return true
}

/** Snapshot equality for the dirty indicator — order-insensitive on keys. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}
