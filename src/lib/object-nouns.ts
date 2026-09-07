/**
 * Noun helpers shared by the object dialog (client) and the object
 * registry program (server). Pure — this file must never import the db.
 */

export const slugifyNoun = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** A plural the dialog can suggest from a singular; always editable. */
export function suggestPlural(singular: string): string {
  const s = singular.trim()
  if (!s) return ''
  const lower = s.toLowerCase()
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${s}es`
  if (/[^aeiou]y$/.test(lower)) return `${s.slice(0, -1)}ies`
  return `${s}s`
}
