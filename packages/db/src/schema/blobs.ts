import { bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth'

/**
 * **An upload that was promised and may never arrive** (SPA-54, CONTEXT.md
 * "Standing debt" → orphan-blob sweep).
 *
 * Upload is two calls around a direct-to-storage PUT: `prepareDocumentUpload`
 * hands out a URL, the browser PUTs the bytes, and only then does
 * `finalizeDocumentUpload` write the `document` row. A tab closed between the
 * PUT and the finalize leaves bytes in the store that no row will ever name,
 * and the only GC in the product runs from the other direction — a document
 * row being deleted. Four more entry points (drop-into-note, URL clip, Drive
 * sync, the server intake) reopen the same window, so the reclaim is built
 * once here rather than four times later.
 *
 * **This is an intent row, not a store listing** — and that is the decision,
 * not an implementation detail. The alternative, asking the store what it
 * holds, was rejected for three reasons: it would add `list()` to the frozen
 * `Storage` interface (CONTEXT.md → Storage, "Shape as first specified"); an
 * S3 `LIST` is a paginated scan of the entire bucket, which is a per-night
 * cost proportional to everything ever uploaded rather than to what is
 * pending; and a prefix walk cannot tell an orphan from an arrival still in
 * flight, because a key on disk carries no notion of when it was promised.
 * A row written at prepare time knows exactly that, which is the one fact the
 * sweep needs.
 *
 * The row's life is short by design: written by `prepareDocumentUpload` when
 * the blob is **not** already stored, and deleted by `birthDocumentProgram`
 * — the one path every entry point converges on (SPA-113), so the server
 * intake and every later channel inherit the delete without knowing this
 * table exists. What is left older than the grace period, and named by no
 * `document` row, is what the sweep reclaims.
 *
 * Nothing here references an entity — `sha` is a digest and `prepared_by` is
 * a `user` — so there is no `ENTITY_REFS` entry; `entity-refs.test.ts`
 * staying green is the proof.
 */
export const pendingBlob = pgTable('pending_blob', {
  /** The content address, which is also the storage key. */
  sha: text('sha').primaryKey(),
  /**
   * What the client said it was about to PUT. `bigint` rather than `integer`
   * because `MAX_UPLOAD_BYTES` is a cap this app sets and not one the column
   * should re-impose — `document.size_bytes` is `integer` and predates the
   * question; a byte count is the one place a 2GB ceiling is a real limit.
   */
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  /**
   * When the URL was handed out. The grace period is measured from here, so
   * a re-prepare of the same sha resets the clock — that is an upload
   * starting again, not the old one ageing.
   */
  preparedAt: timestamp('prepared_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Who asked. Nullable because a later entry point may prepare as an
   * integration rather than as a person, exactly as `document.uploaded_by`
   * is nullable for the same reason.
   */
  preparedBy: text('prepared_by').references(() => user.id),
})
