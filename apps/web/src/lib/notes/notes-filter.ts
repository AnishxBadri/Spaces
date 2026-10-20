/**
 * A record's Notes tab filters (D78): All · Filed here · From meetings ·
 * Mentions. The tab head's count reads the same filter, so the two agree.
 * Client-safe.
 * - From meetings may overlap Filed here (a recorder files its note on the
 *   meeting's records); All lists such a note once, under filed.
 * - Mentions are the notes that only mention the record.
 */
export const NOTES_FILTERS = ['all', 'filed', 'meetings', 'mentions'] as const
export type NotesFilter = (typeof NOTES_FILTERS)[number]

export const NOTES_FILTER_LABELS: Record<NotesFilter, string> = {
  all: 'All',
  filed: 'Filed here',
  meetings: 'From meetings',
  mentions: 'Mentions',
}

/** Which lane a listed note came through. */
type NoteLane = 'filed' | 'meeting' | 'mention'

export type NoteLanes<T extends { id: string }> = {
  filed: ReadonlyArray<T>
  fromMeetings: ReadonlyArray<T>
  mentions: ReadonlyArray<T>
}

/** The notes a filter lists, each with the lane it came through. */
export function notesInFilter<T extends { id: string }>(
  lanes: NoteLanes<T>,
  filter: NotesFilter,
): Array<T & { lane: NoteLane }> {
  const as = (rows: ReadonlyArray<T>, lane: NoteLane) =>
    rows.map((n) => ({ ...n, lane }))
  if (filter === 'filed') return as(lanes.filed, 'filed')
  if (filter === 'meetings') return as(lanes.fromMeetings, 'meeting')
  if (filter === 'mentions') return as(lanes.mentions, 'mention')
  const filedIds = new Set(lanes.filed.map((n) => n.id))
  return [
    ...as(lanes.filed, 'filed'),
    ...as(
      lanes.fromMeetings.filter((n) => !filedIds.has(n.id)),
      'meeting',
    ),
    ...as(lanes.mentions, 'mention'),
  ]
}

/** How many notes each filter lists. */
export function notesCounts<T extends { id: string }>(
  lanes: NoteLanes<T>,
): Record<NotesFilter, number> {
  return {
    all: notesInFilter(lanes, 'all').length,
    filed: lanes.filed.length,
    meetings: lanes.fromMeetings.length,
    mentions: lanes.mentions.length,
  }
}
