import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { actorType } from './actors'
import { entity } from './entities'
import { credential } from './vault'
import type { Json } from '../json'

/**
 * The AI provider contract's tables (spec-ai-substrate §4, §9).
 * - Features never name a model, only a lane; `ai_route` turns lane ×
 *   sensitivity into a provider and a model (`aiRouteProgram` reads it).
 * - `ai_usage` is the per-call cost ledger; `completeProgram` is its only writer.
 * - `ai_run` is the run log the calls roll up into.
 */

/** What a feature asks for. `vision` is an LLM with image input (spec §9). */
export const aiLane = pgEnum('ai_lane', [
  'extract',
  'classify',
  'synthesize',
  'embed',
  'vision',
  'research',
])
export type AiLane = (typeof aiLane.enumValues)[number]

/**
 * The second routing axis. `sensitive` forces the local provider or refuses —
 * it never falls back to cloud. `resolveSensitivity` decides it (record →
 * filed spaces → storage binding → workspace default); a route only keys on it.
 */
export const aiSensitivity = pgEnum('ai_sensitivity', ['normal', 'sensitive'])
export type AiSensitivity = (typeof aiSensitivity.enumValues)[number]

export const aiRoute = pgTable(
  'ai_route',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lane: aiLane('lane').notNull(),
    sensitivity: aiSensitivity('sensitivity').notNull(),
    /**
     * A provider id (`LLM_PROVIDERS`). Text rather than an enum: the provider
     * list grows by adapter, in app code, and the id is validated where it is
     * written and again where it is read.
     */
    provider: text('provider').notNull(),
    /** The provider's own model id, e.g. `claude-haiku-4-5`. */
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('ai_route_lane_sensitivity_unique').on(t.lane, t.sensitivity)],
)

// ---------- the run log ----------

/**
 * A run's status. `running` is the birth state, as `job_run`'s is.
 * - The row exists before the outcome does, so a run whose process died is
 *   left `running` and the Usage page shows it so.
 * - Nothing sweeps it to `failed`, because nothing knows it failed.
 */
export const aiRunStatus = pgEnum('ai_run_status', [
  'running',
  'done',
  'failed',
])
export type AiRunStatus = (typeof aiRunStatus.enumValues)[number]

/**
 * One step of a run: one lane call, or one extraction-cache answer standing
 * in for it. Snake-cased because it is stored JSON, read back as written.
 *
 * - `tool` is the lane the step ran on (`extract`, `synthesize`, …).
 * - `input_refs` are the ContextItem refs the call was shown — resolved to
 *   names through `cite` on the Usage page.
 * - `output_ref` is what the step produced: `suggestion:<id>` for a step that
 *   proposed (the first suggestion it wrote; the run's suggestions are every
 *   `suggestion.run_id` row), a context ref for one that wrote a document's
 *   text, null for a step that produced nothing a person can open.
 * - `job_run_id` is the worker attempt the step ran in, when one is known —
 *   0..1 per step; a request-path step has none.
 * - `model` and the token pair are what the call reported, the same numbers
 *   its `ai_usage` row carries; a `cached` step made no call, so its tokens
 *   are null and it has no `ai_usage` row.
 */
export type AiRunStep = {
  tool: AiLane
  input_refs: ReadonlyArray<string>
  output_ref: string | null
  job_run_id: string | null
  /** ISO 8601 — when the step finished. */
  at: string
  cached?: boolean
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
}

/**
 * The run log (spec-ai-substrate §6): one row per logical AI action ("Read
 * deck and summarize") with its ordered steps.
 * - Every suggestion it produced cites it (`suggestion.run_id`), as every call
 *   it made does (`ai_usage.run_id`).
 * - A second table, not a widening of `job_run`: a step is 0..1 worker
 *   attempts, and a request-path call has no job at all.
 * - The only writers are `openRunProgram`, `addStepProgram`,
 * `closeRunProgram`, each one row write.
 */
export const aiRun = pgTable(
  'ai_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** What the action was, in the words the Usage page lists it by. */
    task: text('task').notNull(),
    /** The record the action was about; null once that record is deleted. */
    entityId: uuid('entity_id').references(() => entity.id),
    /**
     * The typed actor pair `suggestion.proposed_by` uses: one column holding a
     * user or an integration id, so no FK.
     */
    startedByType: actorType('started_by_type').notNull(),
    startedById: text('started_by_id'),
    steps: jsonb('steps')
      .$type<ReadonlyArray<AiRunStep>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * The key the first model-calling step resolved; null when every step was
     * a cache answer or an injected test model.
     */
    credentialId: uuid('credential_id').references(() => credential.id, {
      onDelete: 'set null',
    }),
    /** The steps' sum, rolled up as each step lands. */
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    status: aiRunStatus('status').notNull().default('running'),
    /** The failing step's sentence — the provider's own words when it answered with an error. */
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('ai_run_started_at_idx').on(t.startedAt),
    index('ai_run_entity_idx').on(t.entityId),
    check(
      'ai_run_started_by_invariant',
      sql`(${t.startedByType} = 'system') = (${t.startedById} IS NULL)`,
    ),
    // Open ⇔ unfinished; an error only on a failed run.
    check(
      'ai_run_finished_invariant',
      sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL) AND (${t.error} IS NULL OR ${t.status} = 'failed')`,
    ),
  ],
)

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The `job_run` attempt that made this call, when a queued job made it; a
     * plain uuid, no FK. Nullable: a call made from a request — the settings
     * Test call — has no job run.
     */
    jobRunId: uuid('job_run_id'),
    /**
     * The `ai_run` this call was a step of. Nullable: a call outside any run —
     * the settings Test call — is listed on the Usage page under "Calls
     * outside a run".
     */
    runId: uuid('run_id').references(() => aiRun.id),
    lane: aiLane('lane').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** As the provider reported them; null when it reported none. */
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    callerType: actorType('caller_type').notNull(),
    /**
     * A user id when `caller_type = 'user'`, an `integration` id when
     * `'integration'`, null for `'system'` — one column holding either id, so
     * no FK, the same shape as `suggestion.proposed_by_id`.
     */
    callerId: text('caller_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_usage_at_idx').on(t.at),
    index('ai_usage_run_idx').on(t.runId),
    check(
      'ai_usage_caller_invariant',
      sql`(${t.callerType} = 'system') = (${t.callerId} IS NULL)`,
    ),
  ],
)

/**
 * The extraction cache (spec-storage-sources §9): what one extract-lane call
 * answered for one blob, one compiled schema and one model, so asking again
 * is free.
 * - A cache and nothing more: truncating it costs provider calls, never
 *   behaviour.
 * - Rows go with their blob: `reclaimBlobIfOrphaned` drops them when the last
 *   document row on the sha is gone.
 * - `cachedExtractProgram` is the only reader and writer besides that reclaim.
 */
export const extractionCache = pgTable(
  'extraction_cache',
  {
    /**
     * Keyed by the blob, never the document: the same deck filed twice is two
     * `document` rows over one sha, and both read one row here. A digest, not
     * an entity reference, so there is no `ENTITY_REFS` entry.
     */
    blobSha: text('blob_sha').notNull(),
    /**
     * A digest of the compiled registry schema (`schemaFor`), so an attribute
     * added to the object misses rather than replaying a shape that no longer
     * validates.
     */
    schemaKey: text('schema_key').notNull(),
    /**
     * `<provider>:<model>` as the lane routed it, so re-routing the lane
     * re-asks instead of serving another model's answer.
     */
    modelId: text('model_id').notNull(),
    /**
     * The model's structured output as it came back; the caller validates it
     * against the live registry on every read, hit or miss. The reading
     * document's own citations are stored with its id replaced by a
     * placeholder, so a second document over the same blob cites itself.
     */
    patch: jsonb('patch').$type<Json>().notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blobSha, t.schemaKey, t.modelId] })],
)
