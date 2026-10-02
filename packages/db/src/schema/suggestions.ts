import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { actorType } from './actors'
import { aiRun } from './ai'
import { entity } from './entities'
import { user } from './auth'
import type { Json } from '../json'

/**
 * The AI layer's only mutating verb, as a row. A provider, agent or plugin
 * never writes a value: it proposes one here, and a person accepting it
 * writes — through the one write paths, with the accepter as actor and this
 * row as provenance (`attribute_event.suggestion_id`).
 * - `proposeWith` is the only insert; `acceptProgram` and `rejectProgram`
 *   close rows.
 */

/**
 * What the payload proposes. Only `attribute_patch` has an accept path today;
 * the other four are named now so the queue's vocabulary does not need a
 * migration each time a lane lands, and accept refuses them by name.
 */
export const suggestionKind = pgEnum('suggestion_kind', [
  'attribute_patch',
  'note',
  'ledger_event',
  'identity',
  'document_kind',
  // A space the record may belong in — accepting writes
  // `entity_space(source: 'ai')` through the one tag insert.
  'space_tag',
])

export const suggestionStatus = pgEnum('suggestion_status', [
  'open',
  'accepted',
  'rejected',
])

export const suggestion = pgTable(
  'suggestion',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    kind: suggestionKind('kind').notNull(),
    /**
     * Per kind. `attribute_patch`: the `Proposal` of
     * `@spaces/core/ai/schema` — `{[slug]: {value, refs, confidence}}` —
     * validated at propose *and* again at accept, because the registry may
     * have moved in between.
     */
    payload: jsonb('payload').$type<Json>().notNull(),
    rationale: text('rationale'),
    /**
     * ContextItem refs — the union of the payload's per-field refs. `text[]`
     * here while `attribute_event.refs` is jsonb: that column says why.
     */
    refs: text('refs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The `ai_run` that produced this — the inbox's "produced by this run".
     * Null for a suggestion no run made.
     */
    runId: uuid('run_id').references(() => aiRun.id),
    proposedByType: actorType('proposed_by_type').notNull(),
    /**
     * Who proposed it, by `proposed_by_type`: a user id for `'user'`; null for
     * `'system'`; for `'integration'`, an `integration` id (plugin port) or an
     * `api_token` id (MCP client) — the inbox joins `api_token` to tell them
     * apart. No FK: it holds ids from three tables, and the proposer is
     * provenance the write path never trusts — `attribute_event` records
     * the accepter.
     */
    proposedById: text('proposed_by_id'),
    status: suggestionStatus('status').notNull().default('open'),
    decidedBy: text('decided_by').references(() => user.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('suggestion_entity_status_idx').on(t.entityId, t.status),
    index('suggestion_run_idx').on(t.runId),
    /**
     * One open proposal per (record, slugs, values) from an integration, so a
     * plugin re-run is a no-op insert (`ON CONFLICT DO NOTHING` in
     * `proposeWith`), not a read-then-write race.
     * - Keyed on slugs + md5 of values, never refs or confidence (a re-run
     *   changes those). jsonb is canonical, so the arrays come out in one order.
     * - Partial: `attribute_patch`, open, `'integration'` only — AI lanes'
     *   rows are unaffected, and a decided row never blocks a fresh proposal.
     * - Every function here is IMMUTABLE, which an index expression requires.
     */
    uniqueIndex('suggestion_open_integration_unique')
      .on(
        t.entityId,
        sql`jsonb_path_query_array(${t.payload}, '$.keyvalue().key')`,
        sql`md5(jsonb_path_query_array(${t.payload}, '$.*.value')::text)`,
      )
      .where(
        sql`${t.status} = 'open' AND ${t.kind} = 'attribute_patch' AND ${t.proposedByType} = 'integration'`,
      ),
    // Decided ⇔ someone decided it, when. An open row carries neither.
    check(
      'suggestion_decision_invariant',
      sql`(${t.status} = 'open') = (${t.decidedAt} IS NULL) AND (${t.status} = 'open') = (${t.decidedBy} IS NULL)`,
    ),
  ],
)
