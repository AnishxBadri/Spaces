/**
 * Which attribute values the details column folds away: nothing
 * stored, a blank string, or an empty list. `false` and `0` are values.
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** The filled attributes in order, then the empty ones, from one list. */
export function splitByFilled<TDef>(
  defs: ReadonlyArray<TDef>,
  valueOf: (def: TDef) => unknown,
): { filled: Array<TDef>; empty: Array<TDef> } {
  const filled: Array<TDef> = []
  const empty: Array<TDef> = []
  for (const d of defs) (isEmptyValue(valueOf(d)) ? empty : filled).push(d)
  return { filled, empty }
}
