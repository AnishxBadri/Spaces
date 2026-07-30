/**
 * Document policy shared by the server functions, the blob route, and the
 * UI. One definition each — a kind list that disagrees between the create
 * form and the validator is how "other" quietly becomes the only kind.
 */

/**
 * 250MB. Decks and data rooms get large; this is a guard against a runaway
 * upload filling the operator's disk, not a product opinion.
 */
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024

/** Mirrors the document_kind enum. */
export const DOCUMENT_KINDS = [
  'deck',
  'memo',
  'dd',
  'cap_table',
  'legal',
  'article',
  'other',
] as const

export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  deck: 'Deck',
  memo: 'Memo',
  dd: 'Diligence',
  cap_table: 'Cap table',
  legal: 'Legal',
  article: 'Article',
  other: 'Other',
}

/** Filename → the kind a partner would have filed it under anyway. */
export function guessDocumentKind(filename: string): DocumentKind {
  const name = filename.toLowerCase()
  if (/\bdeck\b|pitch|\.pptx?$/.test(name)) return 'deck'
  if (/cap[\s_-]?table|captable/.test(name)) return 'cap_table'
  if (/\bmemo\b/.test(name)) return 'memo'
  if (/\bdd\b|diligence|data[\s_-]?room/.test(name)) return 'dd'
  if (/\bsafe\b|\bsha\b|term[\s_-]?sheet|agreement|\bnda\b/.test(name))
    return 'legal'
  return 'other'
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
