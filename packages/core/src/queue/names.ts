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
   * A note's body or an embeddable attribute value → its chunks, with
   * vectors when a model is pinned (SPA-132) — `document.embed`'s
   * replace-stamp-embed for the sources that are not documents. `chunk.`
   * and not `note.`, because the row it writes is the chunk and the source
   * rides the payload. Created `stately` and sent with a per-source
   * `singletonKey`, so a burst of note autosaves is one queued job.
   */
  embedSource: 'chunk.embed',
  /**
   * The corpus backfill (SPA-136): every chunk not yet carrying the pinned
   * model's vector, in batches, stopped by the AI cap and resumed after its
   * reset. `chunk.` and not `document.`, because note and attribute chunks
   * are in it too. Created `exclusive` and sent with one fixed
   * `singletonKey`, so there is only ever one run queued or active.
   */
  embedBackfill: 'chunk.embed-backfill',
  /**
   * A saved link → readability text on the same `document` row (SPA-117).
   * `document.` and not `clip.`, because the row it acts on is a document
   * like every other: no separate source table, one search box over decks
   * and articles together (CONTEXT.md → "Sources are documents").
   */
  clipDocument: 'document.clip',
  /**
   * The deck reader (SPA-90): a `kind: deck` document → one `attribute_patch`
   * suggestion per record it is filed against. Created with the `exclusive`
   * policy and sent with `singletonKey = documentId`, so a second press while
   * one is queued or active is refused by pg-boss rather than by a table.
   */
  readDeck: 'document.read-deck',
  /**
   * Kind classify (SPA-62): a document still at `other` once its text is
   * extracted → one `document_kind` suggestion. Enqueued by
   * `onDocumentExtracted` and nothing else, only when the classify lane is
   * routed. Created `exclusive` and sent with `singletonKey = documentId`,
   * so a re-extraction while one is queued adds nothing.
   */
  classifyDocument: 'document.classify',
  /**
   * Space-tag suggestions (SPA-103): a record → one `space_tag` suggestion
   * per space of the live tree the classify lane places it in. Enqueued by
   * the Spaces rail's "Suggest spaces" and nothing else. Created `exclusive`
   * and sent with `singletonKey = entityId`, so a second press while one is
   * queued or active is refused by pg-boss.
   */
  suggestSpaces: 'entity.suggest-spaces',
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
  /**
   * Summarize (SPA-66): a document or a record → one `suggestion(kind:
   * 'note')` on the record the button was pressed on, through the
   * synthesize lane. `entity.` because the scope is either kind. Created
   * `exclusive` and sent with `singletonKey = <record>:<source>`, the deck
   * reader's policy: a second press while one is queued or active is
   * refused by pg-boss.
   */
  summarize: 'entity.summarize',
  /**
   * Key terms (SPA-91): a `legal` or `dd` document filed on a deal → one
   * `suggestion(kind: 'note')` per deal, its body a term / value / citation
   * table. `document.` because the job reads one document. Created
   * `exclusive` and sent with `singletonKey = documentId`, the deck reader's
   * policy: a second press while one is queued or active is refused by
   * pg-boss.
   */
  extractKeyTerms: 'document.key-terms',
  /**
   * The vision lane (SPA-94): a stored PDF at `extraction_status:
   * 'unsupported'` → its pages read by the routed vision model, written as
   * `extracted_text` + `tsv` through extraction's own statement. Enqueued by
   * the Files tab's "Read with vision" and nothing else. Created `exclusive`
   * and sent with `singletonKey = documentId`, so a second press while one
   * is queued or active is refused by pg-boss; never retried.
   */
  visionDocument: 'document.vision',
  /**
   * AI attributes (SPA-72): one cell — a (record, attribute) pair whose
   * attribute carries `options.ai` — → one `attribute_patch` suggestion,
   * plus a registry proposal per option a classify answer wanted and the
   * attribute lacks. Enqueued by the cell trigger on the record rail and in
   * the table, nothing else. Created `exclusive` and sent with
   * `singletonKey = <entityId>:<attributeId>`, so a second press on one
   * cell while one is queued or active is refused by pg-boss.
   */
  attributeRun: 'attribute.run',
  /**
   * Column run (SPA-122, spec-ai-substrate §13 "bulk = job with estimate +
   * per-day cap"): one AI attribute over every record a saved view names —
   * the per-cell program once per row, walked a page at a time, all rows one
   * `ai_run`, stopped by the daily cap. Enqueued by "Run on this view" in a
   * list's column header, nothing else. Created `exclusive` and sent with
   * `singletonKey = <viewId>:<attributeId>`, so a second press while one is
   * queued or active is refused by pg-boss; never retried.
   */
  attributeColumnRun: 'attribute.column-run',
  /**
   * The forwarding mailbox (SPA-56): one IMAP poll of the operator's
   * mailbox → one interaction per new RFC Message-ID. Scheduled by the
   * worker from `mailbox.cadence_minutes` and only while a mailbox row
   * exists; saving the mailbox in Settings → Arrival also sends one, which
   * polls at once and re-syncs that schedule. `singleton`, so two polls never
   * run at the same time over one cursor; never retried — the next tick is
   * the retry, and a refused login backs off rather than hammering.
   */
  pollMailbox: 'mail.poll',
  /**
   * The import commit (SPA-169): one planned batch's rows replayed through
   * their creators, each row in its own transaction, so a failure rolls back
   * that row alone and a re-run writes nothing for a row that already holds
   * its record. Enqueued by the batch page's Commit and Retry failed rows,
   * nothing else. Created `exclusive` and sent with `singletonKey = batchId`,
   * so a double click cannot run two commits of one batch; never retried —
   * a failed row is re-run on its own, by the operator.
   */
  importCommit: 'import.commit',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/**
 * A plugin job's queue: `plugin.<id>.<job>`, with `.interactive` appended
 * for an `interactive: true` job. Not a member of `QueueName`, so a misspelt
 * core name still fails typecheck at every `QueueName` site.
 */
export type PluginQueueName = `plugin.${string}.${string}`

/** What a sender may enqueue onto: a core queue or a plugin's. */
export type EnqueueTarget = QueueName | PluginQueueName

/** The queue the worker registers for a plugin job. */
export const pluginQueueName = (
  pluginId: string,
  job: string,
  interactive: boolean,
): PluginQueueName =>
  `plugin.${pluginId}.${job}${interactive ? '.interactive' : ''}`
