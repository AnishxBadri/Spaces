import { bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth'

/**
 * An upload that was promised and may never arrive.
 * - Written by `prepareDocumentUpload` only when the blob is not already
 *   stored; deleted by `birthDocumentProgram`, the one path every entry
 *   point converges on.
 * - Older than the grace period and named by no `document` row → the orphan
 *   sweep reclaims it.
 * - An intent row, not a store listing. (CONTEXT.md "Orphan blobs")
 */
export const pendingBlob = pgTable('pending_blob', {
  /** The content address, which is also the storage key. */
  sha: text('sha').primaryKey(),
  /**
   * What the client said it was about to PUT. `bigint`: `MAX_UPLOAD_BYTES` is
   * the app's cap, and the column should not re-impose a 2GB one.
   */
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  /**
   * When the URL was handed out; the grace period is measured from here.
   * A re-prepare of the same sha resets the clock — an upload starting again.
   */
  preparedAt: timestamp('prepared_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Who asked. Nullable: an entry point may prepare as an integration, as
   * `document.uploaded_by` is nullable for the same reason.
   */
  preparedBy: text('prepared_by').references(() => user.id),
})
