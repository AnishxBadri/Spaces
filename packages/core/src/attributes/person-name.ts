/**
 * A person's name in two parts: `first_name` and `last_name` are
 * system attributes, and `entity.canonical_name` is their join.
 * - `setValues` keeps the column equal to `joinName` of the parts.
 * - A whole name splits on its last space (`splitName`); one without a
 *   space is a first name only.
 * - The migration that filled the parts splits in SQL exactly as `splitName` does.
 */

export const FIRST_NAME_SLUG = 'first_name'
export const LAST_NAME_SLUG = 'last_name'

export type NameParts = { first: string | null; last: string | null }

/** Whitespace collapsed to single spaces and trimmed. */
const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** A whole name → its parts, split on the last space. */
export function splitName(name: string): NameParts {
  const n = tidy(name)
  if (n === '') return { first: null, last: null }
  const at = n.lastIndexOf(' ')
  if (at === -1) return { first: n, last: null }
  return { first: n.slice(0, at), last: n.slice(at + 1) }
}

/** The parts → the name they make; '' when both are blank. */
export function joinName(first: unknown, last: unknown): string {
  const part = (v: unknown) => (typeof v === 'string' ? tidy(v) : '')
  return [part(first), part(last)].filter((p) => p !== '').join(' ')
}

/** Whether a slug is one of the two name parts. */
export const isNamePart = (slug: string): boolean =>
  slug === FIRST_NAME_SLUG || slug === LAST_NAME_SLUG
