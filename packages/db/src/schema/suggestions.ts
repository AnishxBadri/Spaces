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
 * The AI layer's only mutating verb, as a row (docs/spec-ai-substrate.md §3,
 * §10). A provider, an agent or a plugin never writes a value: it proposes
 * one here, and a person accepting it is what writes — through the existing
 * one-write-paths, with the accepter as actor and this row as provenance
 * (`attribute_event.source = 'suggestion'`, `attribute_event.suggestion_id`).
 *
 * `packages/core/src/writes/suggestions/propose.ts` is the only module that
 * inserts into this table (SPA-204 moved it out of apps/web so the plugin
 * ports reach it); the accept path that closes a row stays in
 * `apps/web/src/lib/ai/propose.ts`.
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
  // SPA-103: a space the record may belong in — accepting writes
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
     * ContextItem refs (spec §1) — the union of the payload's per-field
     * refs. `text[]` here while `attribute_event.refs` is jsonb: see the
     * comment on that column for why the two differ.
     */
    refs: text('refs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The run that produced this (`ai_run`, `schema/ai.ts`; SPA-100) — the
     * inbox's "produced by this run". Null for a suggestion no run made.
     */
    runId: uuid('run_id').references(() => aiRun.id),
    proposedByType: actorType('proposed_by_type').notNull(),
    /**
     * Who proposed it, by `proposed_by_type`: a user id for `'user'`; null
     * for `'system'`; for `'integration'`, **one of two ids** — the
     * `integration` row's (`schema/integrations.ts`) when a plugin's
     * `Judgment` or `Facts` port wrote it, or the `api_token` row's when an
     * MCP client did (`apps/web/src/lib/mcp/tools-propose.ts`; /inbox tells
     * them apart by joining `api_token` on it, `lib/inbox/queue.ts`). A
     * plain text column with no FK, named after `attribute_event.actor_id`:
     * it holds ids from three tables, so no FK fits it, and the proposer is
     * provenance the write path never trusts — the accepter is who
     * `attribute_event` records.
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
     * One open proposal per (record, slugs, values) from an integration
     * (SPA-204): a plugin re-run that raises the same `Facts.fill` conflict
     * or `Judgment.suggest`s the same value again is a no-op insert
     * (`ON CONFLICT DO NOTHING`, `writes/suggestions/propose.ts`), not a
     * read-then-write race. Keyed on the payload's slugs and an md5 of its
     * proposed values — never its per-field refs or confidence, which a
     * re-run changes (each run cites its own receipt). jsonb is stored
     * canonically, so the two jsonpath arrays come out in one order for one
     * payload. Partial: `attribute_patch` only (a note has no slug), open
     * only (a decided row never blocks a fresh proposal), and
     * `'integration'` only — the AI lanes, whose rows are `'user'` or
     * `'system'`, keep writing what they wrote before. Every function here
     * is IMMUTABLE, which an index expression requires.
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
