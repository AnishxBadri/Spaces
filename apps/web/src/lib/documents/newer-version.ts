import type { DocumentKind } from '@spaces/core/documents'

/**
 * "Newer version of" at upload, as pure functions: which of a record's
 * files a new arrival may replace, and when the link may be written.
 * Client-safe: the three adding surfaces and their tests share one copy.
 */

/** A file on the record the new one may be marked newer than. */
export type VersionCandidate = {
  readonly id: string
  readonly filename: string
  readonly kind: DocumentKind
  /** ISO, so newest first is a lexical sort. */
  readonly createdAt: string
}

/**
 * The record's files of the arrival's kind, newest first, never the arrival
 * itself — a re-upload of bytes the record already holds answers that row.
 */
export function versionCandidates<T extends VersionCandidate>(
  documents: ReadonlyArray<T>,
  kind: DocumentKind,
  newerId: string | null = null,
): Array<T> {
  return documents
    .filter((d) => d.kind === kind && d.id !== newerId)
    .sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    )
}

/** One arrival's pick: the older file chosen, and the row once it committed. */
export type VersionPick = {
  readonly key: string
  /** The born document; null until the upload or fetch has committed. */
  readonly newerId: string | null
  /** The file it replaces; null is the default, none. */
  readonly olderId: string | null
}

/**
 * The link is written once both halves are known: the pick, and the row the
 * birth committed. A failed arrival never gets a `newerId`, so it never links.
 */
export function linkReady(
  pick: VersionPick,
): pick is VersionPick & { newerId: string; olderId: string } {
  return (
    pick.newerId !== null &&
    pick.olderId !== null &&
    pick.newerId !== pick.olderId
  )
}
