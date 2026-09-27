import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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
 * `apps/web/src/lib/ai/propose.ts` is the only module that writes this table.
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
     * A user id when `proposed_by_type = 'user'`, the `integration` row's
     * id (`schema/integrations.ts`) when `'integration'`, null for
     * `'system'`. A plain column with no FK, named after
     * `attribute_event.actor_id`: one column holds either id, so neither FK
     * fits it, and the proposer is provenance the write path never trusts —
     * the accepter is who `attribute_event` records.
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
    // Decided ⇔ someone decided it, when. An open row carries neither.
    check(
      'suggestion_decision_invariant',
      sql`(${t.status} = 'open') = (${t.decidedAt} IS NULL) AND (${t.status} = 'open') = (${t.decidedBy} IS NULL)`,
    ),
  ],
)
