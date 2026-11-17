import { byMemoThenRecent } from './ordering'
import type { NoteOrder } from './ordering'

/**
 * A record's Notes tab, in the order it draws: the notes filed here or
 * mentioning it (memos first, then recent), then the notes from its
 * meetings, then every superseded note last. Client-safe.
 * - A note in two lanes is listed once, in the first.
 * - A superseded note leaves its lane for the foot, whatever lane it was in.
 */

export type NoteLanes<T extends { id: string }> = {
  filed: ReadonlyArray<T>
  fromMeetings: ReadonlyArray<T>
  mentions: ReadonlyArray<T>
}

type Groupable = NoteOrder & { id: string; supersededBy: string | null }

type Groups<T> = { notes: Array<T>; meetings: Array<T>; superseded: Array<T> }

export function recordNoteGroups<T extends Groupable>(
  lanes: NoteLanes<T>,
): Groups<T> {
  const seen = new Set<string>()
  const once = (rows: ReadonlyArray<T>) =>
    rows.filter((n) => {
      if (seen.has(n.id)) return false
      seen.add(n.id)
      return true
    })
  const notes = once([...lanes.filed, ...lanes.mentions]).sort(byMemoThenRecent)
  const meetings = once(lanes.fromMeetings)
  const current = (n: T) => n.supersededBy === null
  return {
    notes: notes.filter(current),
    meetings: meetings.filter(current),
    superseded: [...notes, ...meetings]
      .filter((n) => !current(n))
      .sort((a, b) =>
        a.updatedAt === b.updatedAt ? 0 : a.updatedAt > b.updatedAt ? -1 : 1,
      ),
  }
}

/** The Notes tab's filter: every note, or one of the three it splits into. */
export const NOTE_FILTERS = ['all', 'memo', 'note', 'meeting'] as const
export type NoteFilter = (typeof NOTE_FILTERS)[number]

/**
 * What each filter holds, current notes only: the memos and the notes filed
 * here or mentioning it, and the meetings' notes whatever their kind. The
 * three never overlap.
 */
export function noteFilterCounts<T extends Groupable>(
  groups: Groups<T>,
): Record<Exclude<NoteFilter, 'all'>, number> {
  return {
    memo: groups.notes.filter((n) => n.kind === 'memo').length,
    note: groups.notes.filter((n) => n.kind === 'note').length,
    meeting: groups.meetings.length,
  }
}

/**
 * The groups a filter shows. A superseded note is history rather than a
 * kind, so only `all` keeps the superseded fold.
 */
export function filterNoteGroups<T extends Groupable>(
  groups: Groups<T>,
  filter: NoteFilter,
): Groups<T> {
  switch (filter) {
    case 'all':
      return groups
    case 'meeting':
      return { notes: [], meetings: groups.meetings, superseded: [] }
    case 'memo':
    case 'note':
      return {
        notes: groups.notes.filter((n) => n.kind === filter),
        meetings: [],
        superseded: [],
      }
  }
}

/** How many notes the tab lists: each note once. */
export function recordNotesCount<T extends { id: string }>(
  lanes: NoteLanes<T>,
): number {
  return new Set(
    [...lanes.filed, ...lanes.fromMeetings, ...lanes.mentions].map((n) => n.id),
  ).size
}
