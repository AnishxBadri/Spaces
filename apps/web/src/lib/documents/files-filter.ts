import { Schema } from 'effect'
import type { FileType } from './files-tab'

/**
 * What the Files page can be narrowed and arranged by, as data: the facets'
 * values and labels, the groupings and sorts, and the address's spelling of
 * each. Client-safe, so the page, the list query and its test share one
 * copy; the SQL that applies them is `files-filter-sql`.
 */

/** Where a file came from, as the `From` facet and the source bands name it. */
export const FILES_FROM = ['upload', 'email', 'drive', 'link'] as const
export type FilesFrom = (typeof FILES_FROM)[number]

/** A file's format, not its kind: the kinds are the tabs. */
export const FILES_FORMATS = [
  'pdf',
  'sheet',
  'document',
  'slides',
  'image',
  'web',
] as const
export type FilesFormat = (typeof FILES_FORMATS)[number]

/** `Needs a look`: a file whose text could not be read, or whose bytes were let go. */
export const FILES_LOOKS = ['unread', 'text-only'] as const
export type FilesLook = (typeof FILES_LOOKS)[number]

export const FILES_GROUPS = [
  'date',
  'record',
  'source',
  'adder',
  'none',
] as const
export type FilesGroup = (typeof FILES_GROUPS)[number]

export const FILES_SORTS = ['newest', 'oldest', 'name', 'largest'] as const
export type FilesSort = (typeof FILES_SORTS)[number]

export const FROM_LABELS: Readonly<Record<FilesFrom, string>> = {
  upload: 'Upload',
  email: 'Email',
  drive: 'Drive',
  link: 'Link',
}

export const FORMAT_LABELS: Readonly<Record<FilesFormat, string>> = {
  pdf: 'PDF',
  sheet: 'Sheet',
  document: 'Document',
  slides: 'Slides',
  image: 'Image',
  web: 'Web page',
}

export const LOOK_LABELS: Readonly<Record<FilesLook, string>> = {
  unread: 'Text not read',
  'text-only': 'Only text kept',
}

export const GROUP_LABELS: Readonly<Record<FilesGroup, string>> = {
  date: 'Date',
  record: 'Record',
  source: 'Source',
  adder: 'Added by',
  none: 'None',
}

export const SORT_LABELS: Readonly<Record<FilesSort, string>> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name',
  largest: 'Largest first',
}

/** The arrange menu's own label: `By record`, `Not grouped`. */
export const arrangeLabel = (group: FilesGroup): string =>
  group === 'none'
    ? 'Not grouped'
    : group === 'adder'
      ? 'By adder'
      : `By ${GROUP_LABELS[group].toLowerCase()}`

/**
 * The format each glyph type is filed under in `Type`; null for the types
 * no chip names (an archive, a saved email, an unknown file).
 */
export const FORMAT_OF_TYPE: Readonly<Record<FileType, FilesFormat | null>> = {
  pdf: 'pdf',
  doc: 'document',
  txt: 'document',
  'google-doc': 'document',
  xls: 'sheet',
  'google-sheet': 'sheet',
  ppt: 'slides',
  'google-slides': 'slides',
  img: 'image',
  zip: null,
  eml: null,
  file: null,
}

/**
 * The lanes that bring email rather than files from a folder: a file one of
 * them brought is `From` email.
 */
export const MAIL_CAPABILITIES: ReadonlyArray<string> = [
  'gmail',
  'core.mailbox',
]

/** The filters that are on. Facets are ANDed; the values inside one are ORed. */
export type FilesFilters = {
  /** A record or space it is filed under directly. */
  readonly under: string | null
  /** Filed under nothing; ORed with `under`, one facet. */
  readonly unfiled: boolean
  readonly from: ReadonlyArray<FilesFrom>
  readonly type: ReadonlyArray<FilesFormat>
  /** The member who added it. */
  readonly by: string | null
  readonly look: ReadonlyArray<FilesLook>
}

/** The facets, by the keys the counts and the panel name them. */
export type FilesFacet = 'under' | 'from' | 'type' | 'by' | 'look'

export const NO_FILTERS: FilesFilters = {
  under: null,
  unfiled: false,
  from: [],
  type: [],
  by: null,
  look: [],
}

const uuid = Schema.String.check(Schema.isUUID())

/** The list query's filters at the server-fn boundary. */
export const FilesFiltersSchema = Schema.Struct({
  under: Schema.NullOr(uuid),
  unfiled: Schema.Boolean,
  from: Schema.Array(Schema.Literals(FILES_FROM)),
  type: Schema.Array(Schema.Literals(FILES_FORMATS)),
  by: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
  look: Schema.Array(Schema.Literals(FILES_LOOKS)),
})

/** How many filters are on: the `Filter 2` count. */
export function filtersOn(f: FilesFilters): number {
  return (
    (f.under === null ? 0 : 1) +
    (f.unfiled ? 1 : 0) +
    f.from.length +
    f.type.length +
    (f.by === null ? 0 : 1) +
    f.look.length
  )
}

/**
 * The filters as the address spells them: one comma list per facet, each
 * absent when empty, so `/files` stays plain. `under` holds the record's or
 * space's id and the `unfiled` token.
 */
export type FilesFiltersAddress = {
  readonly under?: string | undefined
  readonly from?: string | undefined
  readonly type?: string | undefined
  readonly by?: string | undefined
  readonly look?: string | undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The tokens of a comma list that are one of `allowed`, each once, in `allowed`'s order. */
function tokens<T extends string>(
  list: string | undefined,
  allowed: ReadonlyArray<T>,
): Array<T> {
  const have = new Set((list ?? '').split(','))
  return allowed.filter((t) => have.has(t))
}

/** The address read as filters; an unknown token is dropped, not an error. */
export function filtersOf(address: FilesFiltersAddress): FilesFilters {
  const under = (address.under ?? '').split(',')
  const by = address.by?.trim() ?? ''
  return {
    under: under.find((t) => UUID.test(t))?.toLowerCase() ?? null,
    unfiled: under.includes('unfiled'),
    from: tokens(address.from, FILES_FROM),
    type: tokens(address.type, FILES_FORMATS),
    by: by === '' ? null : by,
    look: tokens(address.look, FILES_LOOKS),
  }
}

const list = (values: ReadonlyArray<string>): string | undefined =>
  values.length === 0 ? undefined : values.join(',')

/** Filters as the address spells them; every empty facet is `undefined`. */
export function addressOf(f: FilesFilters): {
  under: string | undefined
  from: string | undefined
  type: string | undefined
  by: string | undefined
  look: string | undefined
} {
  return {
    under: list([
      ...(f.under === null ? [] : [f.under]),
      ...(f.unfiled ? ['unfiled'] : []),
    ]),
    from: list(f.from),
    type: list(f.type),
    by: f.by === null ? undefined : f.by,
    look: list(f.look),
  }
}

/** `values` with `value` added, or taken out when it is there. */
export function toggled<T extends string>(
  values: ReadonlyArray<T>,
  value: T,
  order: ReadonlyArray<T>,
): Array<T> {
  const next = new Set(values)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return order.filter((v) => next.has(v))
}
