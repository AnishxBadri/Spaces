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
import type { Json } from '../json'

/**
 * The provider contract's two tables (docs/spec-ai-substrate.md §4, §9).
 * Features never name a model — they name a **lane** — and `ai_route` is the
 * settings table that turns lane × sensitivity into a provider and a model.
 * `ai_usage` is the per-call ledger the operator reads for cost.
 *
 * `apps/web/src/lib/ai/route.ts` reads `ai_route`;
 * `apps/web/src/lib/ai/complete.ts` is the only writer of `ai_usage`.
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
