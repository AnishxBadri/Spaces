import type { ReactElement } from 'react'
import type { listRecordDocuments } from '#/lib/server-fns'

/** One row of a record's Files tab, as `listRecordDocuments` answers it. */
export type RecordDocument = Awaited<
  ReturnType<typeof listRecordDocuments>
>[number]

/**
 * A file action a row's `···` offers beyond the fixed ones — Read deck,
 * Summarize, Extract key terms, Read with vision — when its lane can run.
 */
export type FileAction = {
  readonly label: string
  /** Its 16px mark in the `···`. */
  readonly icon: ReactElement
  /** The word while it runs: `reading…`. */
  readonly busyLabel: string
  readonly busy: boolean
  readonly run: () => void
}
