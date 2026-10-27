/**
 * How a thread row reads its people, how a record's interactions group into
 * threads, and how the Interactions tab counts and filters them. Pure, so
 * the rows and their tests share one rule.
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
  const newestFirst = [...rows].sort((a, b) =>
    a.at === b.at ? 0 : a.at < b.at ? 1 : -1,
  )
  for (const row of newestFirst) {
    const key = row.threadId ?? `row:${row.id}`
    const seen = byThread.get(key)
    if (seen === undefined) byThread.set(key, { row, messages: 1 })
    else seen.messages += 1
  }
  return [...byThread.values()].slice(0, limit)
}

/** The Interactions tab's kinds; `all` carries no count. */
export const THREAD_KINDS = ['all', 'email', 'meeting', 'call'] as const
export type ThreadKind = (typeof THREAD_KINDS)[number]

type Threadable = {
  id: string
  threadId: string | null
  at: string
  kind: string
  hasAttachments: boolean
}

/** A thread as the Interactions tab lists it. */
export type Thread<T> = {
  /** The newest message, which the row draws. */
  row: T
  messages: number
  /** Whether any message in it carries an attachment. */
  withFiles: boolean
}

/** Every thread, newest first, with whether any message carries files. */
export function threadsOf<T extends Threadable>(
  rows: ReadonlyArray<T>,
): Array<Thread<T>> {
  const files = new Set(
    rows.flatMap((r) =>
      r.hasAttachments ? [r.threadId ?? `row:${r.id}`] : [],
    ),
  )
  return latestThreads(rows, rows.length).map((t) => ({
    ...t,
    withFiles: files.has(t.row.threadId ?? `row:${t.row.id}`),
  }))
}

/** How many threads the tab head counts: one per thread, not per message. */
export function threadCount(
  rows: ReadonlyArray<{ id: string; threadId: string | null }>,
): number {
  return new Set(rows.map((r) => r.threadId ?? `row:${r.id}`)).size
}

/** Whether a thread is listed under a kind and the files toggle. */
export function threadShown<T extends Threadable>(
  t: Thread<T>,
  kind: ThreadKind,
  withFiles: boolean,
): boolean {
  return (kind === 'all' || t.row.kind === kind) && (!withFiles || t.withFiles)
}

/** Each kind's count and the files toggle's, over every thread. */
export function threadCounts<T extends Threadable>(
  threads: ReadonlyArray<Thread<T>>,
): Record<Exclude<ThreadKind, 'all'> | 'files', number> {
  const of = (kind: string) => threads.filter((t) => t.row.kind === kind).length
  return {
    email: of('email'),
    meeting: of('meeting'),
    call: of('call'),
    files: threads.filter((t) => t.withFiles).length,
  }
}
