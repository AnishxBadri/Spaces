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

/**
 * 2MB of page text: the cap on one `POST /api/v1/capture`. A
 * capture is the visible text of one page posted as JSON through Node, never
 * a presigned PUT, so it is held to a limit a page could plausibly reach —
 * a long profile is tens of KB — and nowhere near `MAX_UPLOAD_BYTES`, which
 * guards bytes that never pass through a request body. Counted in UTF-8
 * bytes of `text`, checked before anything is stored.
 */
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024

/**
 * Mirrors the document_kind enum. There is no `memo` kind: it would collide
 * with `note.kind = 'memo'`. An exported memo PDF is `other` with a
 * `derived_from` edge to its note — provenance, not a genre of file.
 */
export const DOCUMENT_KINDS = [
  'deck',
  'dd',
  'cap_table',
  'legal',
  'article',
  'other',
] as const

export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  deck: 'Deck',
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
  // No `memo` branch: an exported memo is `other` plus a derived_from edge.
  if (/\bdd\b|diligence|data[\s_-]?room/.test(name)) return 'dd'
  if (/\bsafe\b|\bsha\b|term[\s_-]?sheet|agreement|\bnda\b/.test(name))
    return 'legal'
  return 'other'
}

/**
 * The kind folders: a folder's whole name → the kind its files are filed
 * under. Keyed by every kind but `other`, so the vocabulary is
 * `DOCUMENT_KINDS` and nothing else.
 */
export const KIND_FOLDER_NAMES: Record<
  Exclude<DocumentKind, 'other'>,
  ReadonlyArray<string>
> = {
  deck: ['deck', 'pitch'],
  legal: ['legal', 'contracts', 'docs'],
  dd: ['financials', 'dd', 'diligence', 'data room'],
  cap_table: ['cap table', 'captable'],
  article: ['press', 'articles'],
}

const KIND_BY_FOLDER: ReadonlyMap<string, DocumentKind> = new Map(
  DOCUMENT_KINDS.flatMap((kind) =>
    kind === 'other'
      ? []
      : KIND_FOLDER_NAMES[kind].map((n): [string, DocumentKind] => [n, kind]),
  ),
)

/**
 * Folder name → the kind its files are, or null. The whole name, any case,
 * separators read as spaces: "DATA ROOM" and "data_room" are `dd`, "Ohmium
 * Data Room" is not.
 */
export function guessKindFromFolder(folderName: string): DocumentKind | null {
  const name = folderName
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim()
  return KIND_BY_FOLDER.get(name) ?? null
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
