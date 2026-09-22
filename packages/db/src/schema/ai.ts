import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { actorType } from './actors'

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
