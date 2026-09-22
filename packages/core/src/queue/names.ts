/**
 * Job queue names — the seam between web and worker. Web enqueues, worker
 * executes. Anything CPU-bound (extraction, embedding) or slow (enrichment,
 * sync) lives here; the web process must never run it inline.
 *
 * This list lives in @spaces/core rather than beside the worker because both
 * processes need it and `web → worker` is a forbidden edge (spec §2). Once
 * `apps/worker` is lifted out, nothing in the web app follows it.
 *
 * The strings themselves are deliberately unchanged by that move. Spec §11
 * wants `core.<domain>.<verb>`, but a rename is a runtime event, not a file
 * move: in-flight pg-boss jobs are keyed by name and would be orphaned, and
 * the nightly `entity.dedupe-sweep` schedule row would keep firing on the old
 * name with no worker registered for it. That belongs in the slice that owns
 * the worker's boot sequence and can migrate the schedule with it.
 */
export const QUEUES = {
  /** PDF/DOCX/PPTX/XLSX → extracted_text + tsv. */
  extractDocument: 'document.extract',
  /** extracted_text → chunks + embeddings. */
  embedDocument: 'document.embed',
  /**
   * A saved link → readability text on the same `document` row (SPA-117).
   * `document.` and not `clip.`, because the row it acts on is a document
   * like every other: no separate source table, one search box over decks
   * and articles together (CONTEXT.md → "Sources are documents").
   */
  clipDocument: 'document.clip',
  /** Nightly pg_trgm sweep → duplicate_candidate rows. */
  dedupeSweep: 'entity.dedupe-sweep',
  /** On-demand enrichment, credit-capped in the worker. */
  enrichEntity: 'entity.enrich',
  /**
   * Nightly reclaim of bytes a `prepare` promised and no `finalize` ever
   * named (SPA-54). `blob.` and not `document.`, because the rows it acts on
   * are precisely the ones that never became documents.
   */
  sweepOrphanBlobs: 'blob.sweep-orphans',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]
