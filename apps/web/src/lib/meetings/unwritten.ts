/**
 * Whether a meeting still owes a write-up: the one rule the Meetings page's
 * `No write-up` band and Today's write-ups read. Pure and client-safe; the
 * list read's SQL ordering mirrors it.
 */

/**
 * How long after a recorded meeting ends before it counts as unwritten: a
 * recorder's notes usually land within the hour, so nobody is asked to
 * write up what is about to arrive by itself.
 */
export const GRACE_MS = 60 * 60_000

/** What the rule reads of a meeting. */
export type WriteUpOwed = {
  noteId: string | null
  cancelled: boolean
  /** ISO instant the meeting ended; a call's start when it has no end. */
  endsAt: string
  /** Someone attending has a recorder connected (`meeting-notes`). */
  recorded: boolean
}

/**
 * Unwritten: nothing written, not cancelled, and either no recorder is
 * expected or the grace hour since its end has passed.
 */
export function isUnwritten(m: WriteUpOwed, now: Date): boolean {
  if (m.noteId !== null || m.cancelled) return false
  if (!m.recorded) return true
  return now.getTime() - Date.parse(m.endsAt) >= GRACE_MS
}
