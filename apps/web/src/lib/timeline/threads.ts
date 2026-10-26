/**
 * How a thread row reads its people and how a record's latest threads are
 * picked. Pure, so the row and its tests share one rule.
 */

/** A participant as the timeline loader hands it over. */
export type ThreadPerson = {
  name: string
  /** One of the viewer's own person records. */
  self: boolean
}

/**
 * The people lane: never the viewer, and `To <names>` on a row the viewer
 * sent. Empty when nobody else is on it.
 */
export function threadPeople(row: {
  attendees: ReadonlyArray<ThreadPerson>
  sent: boolean
}): string {
  const names = row.attendees.filter((a) => !a.self).map((a) => a.name)
  if (names.length === 0) return ''
  const joined = names.join(' · ')
  return row.sent ? `To ${joined}` : joined
}

/**
 * The newest `limit` threads, newest first: each thread is its newest
 * message with how many messages it holds. A row with no thread id is its
 * own thread.
 */
export function latestThreads<
  T extends { id: string; threadId: string | null; at: string },
>(rows: ReadonlyArray<T>, limit: number): Array<{ row: T; messages: number }> {
  const byThread = new Map<string, { row: T; messages: number }>()
  const newestFirst = [...rows].sort((a, b) => (a.at < b.at ? 1 : -1))
  for (const row of newestFirst) {
    const key = row.threadId ?? `row:${row.id}`
    const seen = byThread.get(key)
    if (seen === undefined) byThread.set(key, { row, messages: 1 })
    else seen.messages += 1
  }
  return [...byThread.values()].slice(0, limit)
}
