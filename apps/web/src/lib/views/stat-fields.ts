/**
 * The read-only interaction columns a list offers beside its attributes
 * (D67): sortable and filterable, never editable, never in `entity.values`.
 * - The slug is the table's column id and a view condition's slug alike;
 *   the colon keeps it apart from every attribute slug (`[a-z0-9_]`).
 * - Client-safe: the SQL half is `interactionStatAt` beside
 *   `entityValuesResolver`.
 */

/** The stat columns a directory row carries, as ISO instants. */
export type RowStats = {
  lastContact: string | null
  lastEmail: string | null
  nextMeeting: string | null
}

export type InteractionStatField = {
  slug: `stat:${string}`
  /** Where a directory row carries it. */
  rowKey: keyof RowStats
  name: string
  /** Which `interaction_stat` row: an interaction kind, or `any`. */
  kind: 'email' | 'meeting' | 'call' | 'any'
  /** Which pair of that row's columns. */
  at: 'first' | 'last' | 'next'
}

export const INTERACTION_STAT_FIELDS: ReadonlyArray<InteractionStatField> = [
  {
    slug: 'stat:last_contact',
    rowKey: 'lastContact',
    name: 'Last contact',
    kind: 'any',
    at: 'last',
  },
  {
    slug: 'stat:last_email',
    rowKey: 'lastEmail',
    name: 'Last email',
    kind: 'email',
    at: 'last',
  },
  {
    slug: 'stat:next_meeting',
    rowKey: 'nextMeeting',
    name: 'Next meeting',
    kind: 'any',
    at: 'next',
  },
]

export const interactionStatField = (
  slug: string,
): InteractionStatField | undefined =>
  INTERACTION_STAT_FIELDS.find((f) => f.slug === slug)

/**
 * The fields as filter-editor entries: a `date` the condition picks a day
 * for. Appended to the registry the view bar is handed, never to a record's
 * editors.
 */
export const INTERACTION_STAT_FILTERS: ReadonlyArray<{
  slug: string
  name: string
  type: string
  options: null
  isSystem: boolean
}> = INTERACTION_STAT_FIELDS.map((f) => ({
  slug: f.slug,
  name: f.name,
  type: 'date',
  options: null,
  isSystem: true,
}))
