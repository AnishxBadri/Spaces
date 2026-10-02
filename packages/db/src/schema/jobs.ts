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
 * The attempt ledger (docs/spec-plugin-sdk.md §11): one row per pg-boss
 * attempt, answering "did the work run, when, and how did it end".
 *
 * - Written by `runJob` and by nothing else — only the wrapper knows when an
 *   attempt started, which attempt it was and how it ended; a handler logging
 *   its own run would miss a defect and a job whose data never parsed.
 * - Both refs are nullable: a core job has no integration, a sweep no entity.
 * - Deliberately **no `tokens` column**; token accounting is `ai_usage` with
 *   `ai_run` as its rollup.
 */

/**
 * - `running` is the birth state — the row exists before the outcome does, so
 *   an attempt that dies with the worker is visible as a run that never finished.
 * - `skipped` is for cache hits and cap refusals, declared up front because
 *   an enum value is a migration.
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
     * stored file to extract text from`. A per-attempt classification on a
     * prunable ledger; not a replacement for a tenant's own current-state text
     * (`document.extraction_error`), which outlives every run.
     */
    error: text('error'),
    /**
     * What a successful attempt did, in the one line its handler returned —
     * `fetched 3 · written 1 · duplicate 1 · refused 1 (auto-submitted 1)`.
     * Null for a handler that returns nothing, and for every failed
     * attempt, whose account is `error`. Still written only by `runJob`.
     */
    summary: text('summary'),
  },
  (t) => [
    index('job_run_entity_idx').on(t.entityId, t.startedAt),
    index('job_run_queue_idx').on(t.queue, t.startedAt),
  ],
)
