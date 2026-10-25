/**
 * A followed file's revisions as the viewer's ledger draws them, newest
 * first. Pure: the reader hands it the document and its `document_revision`
 * rows.
 * - A revision row holds the bytes the document moved *past*, stamped with
 *   when it moved: so rev k began at rev k-1's `at`, and rev 1 at the
 *   document's birth.
 * - The current revision is the document itself: its sha and token.
 */

/** One prior revision as stored: the token its bytes were read at, and when the row moved past them. */
export type PriorRevision = {
  readonly externalRevisionId: string | null
  readonly at: string
}

export type RevisionRow = {
  /** 1 for the bytes first filed, counting up. */
  readonly rev: number
  /** The provider's revision id; null for bytes read before ids were kept. */
  readonly revisionId: string | null
  /** When this revision became ours, ISO. */
  readonly at: string
  readonly current: boolean
}

export function revisionLedger(input: {
  readonly createdAt: string
  readonly currentRevisionId: string | null
  /** Oldest first. */
  readonly priors: ReadonlyArray<PriorRevision>
}): ReadonlyArray<RevisionRow> {
  const { priors } = input
  const rows: Array<RevisionRow> = priors.map((prior, i) => ({
    rev: i + 1,
    revisionId: prior.externalRevisionId,
    at: i === 0 ? input.createdAt : priors[i - 1].at,
    current: false,
  }))
  rows.push({
    rev: priors.length + 1,
    revisionId: input.currentRevisionId,
    at: priors.length === 0 ? input.createdAt : priors[priors.length - 1].at,
    current: true,
  })
  return rows.reverse()
}
