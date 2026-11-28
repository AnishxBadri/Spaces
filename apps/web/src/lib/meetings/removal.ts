import { formatTime, formatWeekday } from '@spaces/core/format'
import { lengthOf } from './list'

/**
 * `Remove from Spaces…`, its pure half, client-safe: how a meeting's key
 * names its series, and the words of the drawn confirm. Times are read in
 * the browser's clock.
 */

/** An occurrence's key: the iCalendar UID, `#`, the occurrence's original start. */
const OCCURRENCE = /^(.+)#\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/

/**
 * The iCalendar UID a meeting's key belongs to, its series' key: the key
 * itself for a single meeting, the part before `#` for an occurrence.
 */
export function seriesUidOf(uid: string): string {
  return OCCURRENCE.exec(uid)?.[1] ?? uid
}

/** What `Remove from Spaces…` can take out, and who may. */
export type MeetingRemoval = {
  /** The meeting is one of a series: the confirm offers `The whole series`. */
  series: boolean
  /** Tasks accepted from its action items; they stay. */
  tasks: number
}

/** The records a meeting is on, as the confirm lists them. */
export type RemovalRecord = { name: string; kind: string }

const KIND_WORD: Record<string, string> = {
  company: 'Company',
  person: 'Person',
  deal: 'Deal',
}

/**
 * The confirm's facts line: `Tue 20 Oct · 14:00 · one of a series`, or the
 * length for a single meeting (`Fri 9 Oct · 11:00 · 45m`).
 */
export function removalFacts(
  m: { startsAt: string; endsAt: string },
  series: boolean,
  today: string,
): string {
  const tail = series ? 'one of a series' : lengthOf(m.startsAt, m.endsAt)
  return [formatWeekday(m.startsAt, today), formatTime(m.startsAt), tail]
    .filter((part) => part !== null)
    .join(' · ')
}

/**
 * What the meeting leaves, in the confirm's list: each record with its kind,
 * then, once it has happened, its write-up and the tasks from it, which stay.
 */
export function removalRows(input: {
  records: ReadonlyArray<RemovalRecord>
  over: boolean
  writeUp: boolean
  tasks: number
}): Array<{ name: string; meta: string }> {
  const rows = input.records.map((r) => ({
    name: r.name,
    meta: KIND_WORD[r.kind] ?? 'Record',
  }))
  if (!input.over) return rows
  if (input.writeUp) rows.push({ name: 'Write-up', meta: 'Stays as a note' })
  if (input.tasks > 0)
    rows.push({
      name: `${String(input.tasks)} ${input.tasks === 1 ? 'task' : 'tasks'}`,
      meta: 'Stays',
    })
  return rows
}

/**
 * A place as `Where` draws it: its first line, the rest of the address
 * under it. A one-line place splits at its first comma, since a calendar
 * filled from a map writes the name and the street on one line.
 */
export function placeLines(location: string): {
  first: string
  rest: string | null
} {
  const lines = location
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const [one = location.trim(), ...more] = lines
  if (more.length > 0) return { first: one, rest: more.join(', ') }
  const comma = one.indexOf(',')
  if (comma < 0) return { first: one, rest: null }
  const rest = one.slice(comma + 1).trim()
  return { first: one.slice(0, comma).trim(), rest: rest === '' ? null : rest }
}

/** The address in a map, in a new tab: the reader's own data, sent only when pressed. */
export function mapUrl(location: string): string {
  const query = location
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query.join(', '))}`
}
