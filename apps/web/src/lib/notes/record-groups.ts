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

export function recordNoteGroups<T extends Groupable>(
  lanes: NoteLanes<T>,
): { notes: Array<T>; meetings: Array<T>; superseded: Array<T> } {
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

/** How many notes the tab lists: each note once. */
export function recordNotesCount<T extends { id: string }>(
  lanes: NoteLanes<T>,
): number {
  return new Set(
    [...lanes.filed, ...lanes.fromMeetings, ...lanes.mentions].map((n) => n.id),
  ).size
}
