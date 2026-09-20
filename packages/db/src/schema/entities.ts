import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
// (values column) — attribute registry lives in ./attributes
import { sql } from 'drizzle-orm'
import { user } from './auth'
import { integration } from './integrations'
import { objectDef } from './objects'
import type { Json } from '../json'

/**
 * Attribute values (system + custom), keyed by attribute slug. The registry
 * (attribute table) defines each slug's shape; validation happens at write
 * (src/lib/attributes/values.ts), so the column claims only what the
 * serializer guarantees.
 */
export type EntityValues = { [slug: string]: Json }

/** Why the sweep paired two entities — a shared alias, a name similarity. */
export type DuplicateReason = Record<string, string>

/**
 * One row the merge executor moved, dropped, filled, or inserted. The
 * snapshot convention is the only unmerge contract (CLAUDE.md), so the
 * shape is declared here, beside the column, not in the executor.
 */
export type MergeSnapshotEntry = {
  table: string
  action:
    'repointed' | 'dropped' | 'field_filled' | 'field_conflict' | 'inserted'
  pk: Record<string, unknown>
  old: Record<string, unknown>
}

/**
 * Polymorphic entity core. Everything linkable is an entity: one mention
 * system, one backlink query, one search index, one attach mechanism.
 * Core kinds are fixed in code; custom objects share the 'custom' kind and
 * are differentiated by object_id (CONTEXT.md "Two-tier object model").
 */

export const entityKind = pgEnum('entity_kind', [
  'company',
  'person',
  'deal',
  'space',
  'note',
  'document',
  'term',
  'custom',
])

/**
 * Provenance, as a class and never as a vendor (CONTEXT.md "Plugin
 * architecture" → Schema deltas; `docs/spec-plugin-sdk.md` §8). The four
 * vendor-named enums baked `gmail`/`apollo`/`clip` into shared types, which
 * is precisely what a third-party plugin cannot migrate safely — so the
 * vendor moves out of the type and into a row: `source_class = 'integration'`
 * plus `source_ref → integration.id`.
 *
 * Eight values, each a different kind of writer, not a different product:
 * `manual` a human in the app (the browser extension's clip included — it is
 * first-party, and a clip is a person clicking a button) · `integration` an
 * installed plugin, named by `source_ref` · `ai` the substrate's own lanes ·
 * `import` a CSV or a backfill · `seed` starter taxonomy and dev data ·
 * `merge` a row the merge executor moved · `extracted` pulled out of a
 * document's text · `inherited` carried down from a parent record.
 */
export const sourceClass = pgEnum('source_class', [
  'manual',
  'integration',
  'ai',
  'import',
  'seed',
  'merge',
  'extracted',
  'inherited',
])

/** The eight classes as a type — one list, declared at the column. */
export type SourceClass = (typeof sourceClass.enumValues)[number]

export const entity = pgTable(
  'entity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: entityKind('kind').notNull(),
    // Set for every record-of-an-object (core kinds + custom), null for
    // research kinds (space/note/document/term). Invariant enforced in
    // code: a core entity's kind agrees with its object row.
    objectId: uuid('object_id').references(() => objectDef.id),
    canonicalName: text('canonical_name').notNull(),
    // Soft merge: loser rows survive and redirect. Chains are flattened at
    // write time — merging B into C repoints every merged_into_id at B.
    mergedIntoId: uuid('merged_into_id'),
    // Attribute values (system + custom), keyed by attribute slug. The
    // registry (attribute table) defines shape; validation happens at write.
    values: jsonb('values').$type<EntityValues>().notNull().default({}),
    sourceClass: sourceClass('source_class').notNull().default('manual'),
    /** The integration that wrote the row; null for every other class. */
    sourceRef: uuid('source_ref').references(() => integration.id),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('entity_kind_idx').on(t.kind),
    // The scope column of everything object-shaped: the nightly dedupe
    // sweep's self-join (`worker/jobs/dedupe-sweep.ts`), the merge guard's
    // same-object refusal, `objectHasRecords`, and every `/o/<slug>` list.
    // Added by SPA-81, which is the slice that gave it a set-based reader.
    index('entity_object_idx').on(t.objectId),
    index('entity_merged_into_idx')
      .on(t.mergedIntoId)
      .where(sql`${t.mergedIntoId} is not null`),
    // A biconditional, the same shape as `attribute_event_actor_invariant`
    // and for the same reason: an implication would let a `seed` row carry
    // an integration id (a provenance lie the dedupe card would render as
    // fact) or let a plugin write a row that cannot say which plugin wrote
    // it. Both directions are the point.
    check(
      'entity_source_ref_invariant',
      sql`(${t.sourceClass} = 'integration') = (${t.sourceRef} IS NOT NULL)`,
    ),
  ],
)

export const aliasKind = pgEnum('alias_kind', [
  'name',
  'domain',
  'email',
  'linkedin',
  'cin',
])

/**
 * Identity lives here, not on side tables — single source of truth.
 * Deterministic keys (domain/email/linkedin/cin) carry is_identity and are
 * globally unique; writing a colliding identity alias must be converted by
 * resolveEntity() into a duplicate_candidate instead of an error.
 * Name aliases are never identity and never unique — they only feed pg_trgm.
 */
export const entityAlias = pgTable(
  'entity_alias',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    kind: aliasKind('kind').notNull(),
    value: text('value').notNull(),
    valueNorm: text('value_norm').notNull(),
    isIdentity: boolean('is_identity').notNull().default(false),
    sourceClass: sourceClass('source_class').notNull().default('manual'),
    /** The integration that wrote the alias; null for every other class. */
    sourceRef: uuid('source_ref').references(() => integration.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('alias_identity_unique')
      .on(t.kind, t.valueNorm)
      .where(sql`${t.isIdentity}`),
    index('alias_entity_idx').on(t.entityId),
    // trgm GIN index on value_norm for fuzzy name matching lives in
    // migration 0000 (drizzle-kit can't express operator classes).
    // Aliases carry the pair too, not just the entity: identity is what a
    // plugin actually writes, and an unattributed alias is the one row that
    // could silently weld two companies together.
    check(
      'entity_alias_source_ref_invariant',
      sql`(${t.sourceClass} = 'integration') = (${t.sourceRef} IS NOT NULL)`,
    ),
  ],
)

export const duplicateStatus = pgEnum('duplicate_status', [
  'open',
  'merged',
  'dismissed',
])

/**
 * The dedupe inbox. `dismissed` persists forever — "not a duplicate" is a
 * negative assertion; without it the nightly sweep re-suggests the same
 * pair eternally. App-side invariant: entityA < entityB (ordered pair).
 */
export const duplicateCandidate = pgTable(
  'duplicate_candidate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityA: uuid('entity_a')
      .notNull()
      .references(() => entity.id),
    entityB: uuid('entity_b')
      .notNull()
      .references(() => entity.id),
    score: real('score').notNull(),
    reason: jsonb('reason').$type<DuplicateReason>().notNull(),
    status: duplicateStatus('status').notNull().default('open'),
    resolvedBy: text('resolved_by').references(() => user.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('duplicate_pair_unique').on(t.entityA, t.entityB),
    index('duplicate_status_idx')
      .on(t.status)
      .where(sql`${t.status} = 'open'`),
  ],
)

/**
 * Merge audit + unmerge capability. Snapshot records every repointed row
 * ({table, pk, old_value}), moved aliases, side-table conflicts, and
 * unique-pair collisions. Captured at merge time or never.
 */
export const mergeEvent = pgTable('merge_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  winnerId: uuid('winner_id')
    .notNull()
    .references(() => entity.id),
  loserId: uuid('loser_id')
    .notNull()
    .references(() => entity.id),
  mergedBy: text('merged_by')
    .notNull()
    .references(() => user.id),
  mergedAt: timestamp('merged_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  snapshot: jsonb('snapshot').$type<Array<MergeSnapshotEntry>>().notNull(),
  unmergedAt: timestamp('unmerged_at', { withTimezone: true }),
})

export const linkRelation = pgEnum('link_relation', [
  'mentions',
  'tagged_in',
  'contact_at',
  'derived_from',
  'supersedes',
  // Materialized record-reference attribute (attr_slug says which one).
  'references',
])

export const linkSource = pgEnum('link_source', ['manual', 'ai', 'extracted'])

/**
 * The one edge table. [[mention]] in a note body materializes a link row —
 * backlinks are `select * from link where to_entity_id = X`.
 */
export const link = pgTable(
  'link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromEntityId: uuid('from_entity_id')
      .notNull()
      .references(() => entity.id),
    toEntityId: uuid('to_entity_id')
      .notNull()
      .references(() => entity.id),
    relation: linkRelation('relation').notNull(),
    // For relation='references': the record-reference attribute this edge
    // materializes. Values jsonb is source of truth; this row is the graph.
    // Empty string (not null) for other relations so the unique edge index
    // can include it without NULL-distinctness loopholes.
    attrSlug: text('attr_slug').notNull().default(''),
    source: linkSource('source').notNull().default('manual'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('link_edge_unique').on(
      t.fromEntityId,
      t.toEntityId,
      t.relation,
      t.attrSlug,
    ),
    index('link_to_idx').on(t.toEntityId),
    index('link_from_idx').on(t.fromEntityId),
  ],
)
