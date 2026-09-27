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
 * The provider contract's two tables (docs/spec-ai-substrate.md §4, §9).
 * Features never name a model — they name a **lane** — and `ai_route` is the
 * settings table that turns lane × sensitivity into a provider and a model.
 * `ai_usage` is the per-call ledger the operator reads for cost.
 *
 * `apps/web/src/lib/ai/route.ts` reads `ai_route`;
 * `apps/web/src/lib/ai/complete.ts` is the only writer of `ai_usage`.
 * `ai_run` (below) is the run log the calls roll up into.
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
 * it never falls back to cloud. Resolved elsewhere (record → filed spaces →
 * storage binding → workspace default, ai-26); a route only keys on it.
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
     * A provider id (`apps/web/src/lib/ai/providers/ids.ts`). Text rather
     * than an enum: the provider list grows by adapter, in app code, and the
     * id is validated where it is written and again where it is read.
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
 * `running` is the birth state, as `job_run`'s is: the row exists before the
 * outcome does, so a run whose process died is left `running` and the Usage
 * page shows it so — nothing sweeps it to `failed`, because nothing knows it
 * failed.
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
 * - `input_refs` are the ContextItem refs the call was shown
 *   (`docs/spec-ai-substrate.md` §1) — resolved to names through
 *   `apps/web/src/lib/context/cite.ts` on the Usage page.
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
 * **The run log** (SPA-100; `docs/spec-ai-substrate.md` §6, §14 step 10): one
 * row per logical AI action — "Read deck", "Summarize", "Read deck and
 * summarize" — with its ordered steps, so a multi-step action is auditable
 * and every suggestion it produced cites it (`suggestion.run_id`), as every
 * call it made does (`ai_usage.run_id`).
 *
 * **Two tables, not one — reconciling the two specs** (owner, 2026-09-27).
 * spec-ai-substrate §6 specifies `run(id, task, steps jsonb, credential_id,
 * tokens, status)`; spec-plugin-sdk §11 says `job_run` is "one table, three
 * consumers", the third being "later the AI run log". They describe
 * different grains. `job_run` (`schema/jobs.ts`) is the worker's attempt
 * ledger — queue, attempt, retry — with one writer, `runJob`. A run is one
 * logical action of 1..n ordered steps, each step 0..1 worker attempts, and
 * a request-path call (the settings Test call) has no job at all. Widening
 * `job_run` with steps would repeat the steps on every retried attempt, and
 * would still leave the request path with nowhere to write. So plugin-sdk
 * §11's third consumer is read as the **Usage surface**, which joins both
 * tables; `job_run` stays one table with its one writer, and this is a
 * second. It follows that `ai_usage.job_run_id` stays nullable — as its own
 * comment argues — and `ai_usage.run_id` beside it is nullable for the same
 * reason: the Test call is outside any run.
 *
 * `started_by` is the typed actor pair `suggestion.proposed_by` uses (one
 * column holding a user or an integration id, so no FK). `tokens_in` /
 * `tokens_out` are the steps' sum, rolled up as each step lands.
 * `credential_id` is the key the first model-calling step resolved; null
 * when every step was a cache answer or an injected test model.
 *
 * `apps/web/src/lib/ai/run.ts` is the only writer: `openRun`, `addStep`,
 * `closeRun`, each one row write.
 */
export const aiRun = pgTable(
  'ai_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** What the action was, in the words the Usage page lists it by. */
    task: text('task').notNull(),
    /** The record the action was about; null once that record is deleted. */
    entityId: uuid('entity_id').references(() => entity.id),
    startedByType: actorType('started_by_type').notNull(),
    startedById: text('started_by_id'),
    steps: jsonb('steps')
      .$type<ReadonlyArray<AiRunStep>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    credentialId: uuid('credential_id').references(() => credential.id, {
      onDelete: 'set null',
    }),
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
     * The attempt that made this call, when a queued job made it. Will
     * reference clean's `job_run` table (`job_run.id`, `schema/jobs.ts`, the
     * attempt ledger); a plain uuid until a job makes a call, and nullable
     * because a call made from a request — the settings Test call — has no
     * job run.
     */
    jobRunId: uuid('job_run_id'),
    /**
     * The run this call was a step of (`ai_run` above). Nullable for the
     * `job_run_id` reason: a call outside any run — the settings Test call —
     * is listed on the Usage page under "Calls outside a run".
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
 * **The extraction cache** (SPA-74; docs/spec-storage-sources.md §9, the
 * derived-layer stack): what one extract-lane call answered for one blob,
 * one compiled schema and one model, so asking again is free.
 *
 * Keyed by the **blob**, never the document: the same deck filed twice is
 * two `document` rows over one sha, and both read one row here. Keyed by
 * `model_id` (`<provider>:<model>` as the lane routed it), so re-routing the
 * lane re-asks instead of serving another model's answer. And keyed by
 * `schema_key`, a digest of the compiled registry schema
 * (`schemaFor`, `@spaces/core/ai/schema`), so an attribute added to the
 * object misses rather than replaying a shape that no longer validates.
 *
 * `patch` is the model's structured output as it came back; the caller
 * validates it against the live registry on every read, hit or miss. The
 * reading document's own citations are stored with its id replaced by a
 * placeholder, so a second document over the same blob cites itself.
 *
 * It is a cache and nothing more: truncating it costs provider calls, never
 * behaviour. Rows go with their blob — `reclaimBlobIfOrphaned`
 * (`apps/web/src/lib/documents/blob-refs.ts`) drops them when the last
 * document row on the sha is gone. `blob_sha` is a digest, not an entity
 * reference, so there is no `ENTITY_REFS` entry.
 *
 * `apps/web/src/lib/ai/extraction-cache.ts` is the only reader and writer
 * besides that reclaim.
 */
export const extractionCache = pgTable(
  'extraction_cache',
  {
    blobSha: text('blob_sha').notNull(),
    schemaKey: text('schema_key').notNull(),
    modelId: text('model_id').notNull(),
    patch: jsonb('patch').$type<Json>().notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blobSha, t.schemaKey, t.modelId] })],
)
