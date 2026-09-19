import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { entity } from './entities'
import { integration } from './integrations'

/**
 * The attempt ledger (`docs/spec-plugin-sdk.md` §11). One row per pg-boss
 * attempt, written by `runJob` and by nothing else: extraction, every plugin
 * job the SDK registers, the storage list job and the ingest job all inherit
 * the row rather than each instrumenting itself. The wrapper is the only
 * place that knows when an attempt started, which attempt it was, and how it
 * ended, so it is the only place that can write this honestly — a handler
 * that logged its own run would miss the two cases that matter most, a defect
 * and a job whose data never parsed.
 *
 * Both refs are nullable because both are genuinely absent half the time: a
 * core job has no integration, and a sweep has no entity.
 *
 * There is deliberately **no `tokens` column**. Spec §11's sketch carries one;
 * it is overridden here. An attempt that is retried would double-count its
 * tokens against a job whose row is per-attempt, and the ledger has no way to
 * tell a re-charged call from a replayed one. Token accounting belongs to
 * `ai_usage` (the per-call ledger) with ai-25a's `ai_run` as its rollup; this
 * table answers "did the work run, when, and how did it end".
 */

/**
 * `running` is the birth state — the row exists before the outcome does, so an
 * attempt that dies with the worker is visible as a run that never finished.
 * `skipped` is pinned here rather than added later: sdk-16's cache hits and
 * cap refusals need the word, and an enum value is a migration. Nothing in
 * this slice writes it.
 */
export const jobRunStatus = pgEnum('job_run_status', [
  'running',
  'succeeded',
  'failed',
  'skipped',
])

export type JobRunStatus = (typeof jobRunStatus.enumValues)[number]

export const jobRun = pgTable(
  'job_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The pg-boss queue name, e.g. `document.extract`. */
    queue: text('queue').notNull(),
    /** The installed integration this job belongs to; null for a core job. */
    integrationId: uuid('integration_id').references(() => integration.id),
    /** The record the job is about; null for a sweep or a cron job. */
    entityId: uuid('entity_id').references(() => entity.id),
    status: jobRunStatus('status').notNull().default('running'),
    /** 1-based, as pg-boss counts: retry_count + 1. */
    attempt: integer('attempt').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Null while the attempt is still running, or if the worker died. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    /**
     * The wrapper's typed outcome tag, then its reason — `permanent: No
     * stored file to extract text from`. Not a replacement for the operator
     * text a tenant writes on its own row (`document.extraction_error`): this
     * column is a per-attempt classification on a prunable ledger, and that
     * one is the current state of the document, which outlives every run.
     */
    error: text('error'),
  },
  (t) => [
    index('job_run_entity_idx').on(t.entityId, t.startedAt),
    index('job_run_queue_idx').on(t.queue, t.startedAt),
  ],
)
