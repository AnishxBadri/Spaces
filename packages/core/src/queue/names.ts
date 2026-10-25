/**
 * Job queue names: web enqueues, the worker executes. Anything CPU-bound
 * (extraction, embedding) or slow (enrichment, sync) runs here; the web
 * process must never run it inline.
 *
 * Lives in core because both processes need it and web must never import
 * the worker. Never rename a queue string casually: in-flight pg-boss jobs
 * are keyed by name and would be orphaned, and the nightly
 * `entity.dedupe-sweep` schedule row would keep firing on the old name.
 */
export const QUEUES = {
  /** PDF/DOCX/PPTX/XLSX → extracted_text + tsv. */
  extractDocument: 'document.extract',
  /** extracted_text → chunks + embeddings. */
  embedDocument: 'document.embed',
  /**
   * A note body or embeddable attribute value → its chunks, with vectors
   * when a model is pinned. Named `chunk.` because the row it writes is the
   * chunk. `stately` with a per-source `singletonKey`, so a burst of note
   * autosaves is one queued job.
   */
  embedSource: 'chunk.embed',
  /**
   * Corpus backfill: every chunk lacking the pinned model's vector, in
   * batches, stopped by the AI cap and resumed after its reset. `exclusive`
   * with one fixed `singletonKey`, so only one run is ever queued or active.
   */
  embedBackfill: 'chunk.embed-backfill',
  /**
   * The lowering half of `chunk.sensitive`: one entity's chunks restamped
   * from the live resolver after a flag is cleared or a filing removed.
   * `stately` with `singletonKey = entityId`, so a burst is one queued job.
   */
  restampSensitivity: 'sensitivity.restamp',
  /**
   * A saved link → readability text on the same `document` row. Sources are
   * documents: no separate clip table, one search over decks and articles.
   */
  clipDocument: 'document.clip',
  /**
   * A pasted storage-source link (Drive) → one document, fetched with the
   * acting user's grant. Per-paste `singletonKey` the Files tab polls; a file
   * already held for that connection is re-filed, never downloaded again.
   */
  fetchStorageFile: 'document.fetch-storage',
  /**
   * Link a Drive folder: its ancestry read with the binding user's grant,
   * then the guarded bind. Per-bind `singletonKey` the bind dialog polls; a
   * refusal is the job's permanent reason.
   */
  bindStorageFolder: 'storage.bind-folder',
  /**
   * A binding's sync: the bound folder walked with the binder's grant, every
   * file filed on the bound record. `stately` with `singletonKey =
   * bindingId`, so two syncs of one binding never overlap; a re-run files
   * nothing twice.
   */
  syncStorageBinding: 'storage.sync',
  /**
   * Quarter-hourly change poll: one `changes` pass per connection with an
   * active folder binding. `singleton`, so two polls never share a cursor;
   * never retried — the next tick is the retry, and the cursor only advances
   * once a page is handled.
   */
  pollStorageChanges: 'storage.poll',
  /**
   * Write-through: an in-app upload on a pushing binding is put in the bound
   * folder; a re-filed or renamed export is moved or renamed there.
   * `stately` with `singletonKey = documentId`; retried with backoff for
   * about a day while no connection can write, counted on Today meanwhile.
   */
  exportDocument: 'storage.export',
  /**
   * A `remote` document's bytes fetched back for preview or download, held
   * under the sha with a `pending_blob` intent so the orphan sweep is the
   * cache's expiry. `stately` with `singletonKey = documentId`; the viewer
   * polls it.
   */
  fetchRemoteBytes: 'storage.fetch-bytes',
  /**
   * A binding flipped `text → full`: one job per `remote` document, which
   * fetches the bytes and marks the row `stored`. `stately` with
   * `singletonKey = documentId`.
   */
  retainBackfill: 'storage.retain-backfill',
  /**
   * Deck reader: a `kind: deck` document → one `attribute_patch` suggestion
   * per record it is filed on. `exclusive` with `singletonKey = documentId`,
   * so pg-boss refuses a second press while one is queued or active.
   */
  readDeck: 'document.read-deck',
  /**
   * Kind classify: a document still at `other` once extracted → one
   * `document_kind` suggestion. Enqueued only by `onDocumentExtracted`, only
   * when the classify lane is routed. `exclusive` with `singletonKey =
   * documentId`, so a re-extraction while one is queued adds nothing.
   */
  classifyDocument: 'document.classify',
  /**
   * Live-file ledger events: a new revision of a bound cap table filed on a
   * held company, read against the holding → at most one `ledger_event`
   * suggestion. Enqueued only by `onDocumentExtracted`. `exclusive` with
   * `singletonKey = <documentId>:<revision>`: one revision, one queued job.
   */
  proposeLedgerEvent: 'document.ledger-event',
  /**
   * Space-tag suggestions: a record → one `space_tag` suggestion per space
   * the classify lane places it in. Enqueued only by "Suggest spaces".
   * `exclusive` with `singletonKey = entityId`, so pg-boss refuses a second
   * press while one is queued or active.
   */
  suggestSpaces: 'entity.suggest-spaces',
  /** Nightly pg_trgm sweep → duplicate_candidate rows. */
  dedupeSweep: 'entity.dedupe-sweep',
  /**
   * An enrichment run: the owner's sources asked in order for one record,
   * every answer applied at once. `stately` with `singletonKey = entityId`,
   * so a burst of triggers is one queued run.
   */
  enrichmentRun: 'enrichment.run',
  /**
   * Nightly reclaim of bytes a `prepare` promised and no `finalize` named.
   * `blob.` because these rows never became documents.
   */
  sweepOrphanBlobs: 'blob.sweep-orphans',
  /**
   * Summarize: a document or record → one `note` suggestion on the record
   * the button was pressed on, through the synthesize lane. `exclusive` with
   * `singletonKey = <record>:<source>`, so pg-boss refuses a second press
   * while one is queued or active.
   */
  summarize: 'entity.summarize',
  /**
   * Key terms: a `legal` or `dd` document filed on a deal → one `note`
   * suggestion per deal, its body a term / value / citation table.
   * `exclusive` with `singletonKey = documentId`, so pg-boss refuses a
   * second press while one is queued or active.
   */
  extractKeyTerms: 'document.key-terms',
  /**
   * Vision lane: a stored PDF at `extraction_status: 'unsupported'` → pages
   * read by the vision model, written as `extracted_text` + `tsv` through
   * extraction's own statement. Enqueued only by "Read with vision".
   * `exclusive` with `singletonKey = documentId`; never retried.
   */
  visionDocument: 'document.vision',
  /**
   * AI attribute, one cell (record × attribute with `options.ai`) → one
   * `attribute_patch` suggestion, plus a registry proposal per option a
   * classify answer wanted and the attribute lacks. `exclusive` with
   * `singletonKey = <entityId>:<attributeId>`, so a second press on one cell
   * while one is queued or active is refused.
   */
  attributeRun: 'attribute.run',
  /**
   * Column run: one AI attribute over every record a saved view names, a
   * page at a time, all rows one `ai_run`, stopped by the daily cap.
   * Enqueued only by "Run on this view". `exclusive` with `singletonKey =
   * <viewId>:<attributeId>`; never retried.
   */
  attributeColumnRun: 'attribute.column-run',
  /**
   * Forwarding mailbox: one IMAP poll → one interaction per new Message-ID.
   * Scheduled from `mailbox.cadence_minutes` only while a mailbox row
   * exists; saving the mailbox also sends one. `singleton`, so two polls
   * never share a cursor; never retried — the next tick is the retry, and a
   * refused login backs off rather than hammering.
   */
  pollMailbox: 'mail.poll',
  /**
   * Import commit: a planned batch's rows replayed through their creators,
   * each in its own transaction, so a failure rolls back that row alone and
   * a re-run skips rows that hold their record. `exclusive` with
   * `singletonKey = batchId`, so a double click cannot run two commits;
   * never retried — the operator re-runs a failed row.
   */
  importCommit: 'import.commit',
  /**
   * Nightly delete of stored webhook deliveries past
   * `INGRESS_RETENTION_DAYS`. Retried: a delete by cutoff is idempotent.
   */
  pruneIngress: 'ingress.prune',
  /**
   * Rebuilds the `interaction_stat` rows whose next meeting has started, so
   * it becomes their last. Retried, since a recompute is idempotent.
   */
  rollInteractionStats: 'interaction-stats.roll',
  /**
   * An email's one-line summary and category labels, through the synthesize
   * and classify lanes under the sensitivity gate, written once into
   * `interaction.meta`. `stately` with `singletonKey = interactionId`.
   */
  summarizeEmail: 'interaction.summarize-email',
  /**
   * Nightly: every email still missing its summary or categories, a page at
   * a time — never rewriting one a lane wrote. `singleton`, so two runs
   * never walk the same pages.
   */
  summarizeEmailBackfill: 'interaction.summarize-backfill',
  /**
   * A recorded note's action items: the Extract lane proposes one `task`
   * suggestion per item, under the sensitivity gate. Sent by
   * `Content.logRecordedNote`. `stately` with `singletonKey = noteId`.
   */
  recordedNoteTasks: 'interaction.recorded-note-tasks',
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
