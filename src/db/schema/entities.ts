import {
  boolean,
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

/**
 * Polymorphic entity core. Everything linkable is an entity: one mention
 * system, one backlink query, one search index, one attach mechanism.
 * Kinds are fixed in code — this is not a custom-object builder.
 */

export const entityKind = pgEnum('entity_kind', [
  'company',
  'person',
  'organization',
  'deal',
  'space',
  'thesis',
  'note',
  'document',
  'term',
])

export const entitySource = pgEnum('entity_source', [
  'manual',
  'gmail',
  'apollo',
  'import',
  'clip',
  'seed',
])

export const entity = pgTable(
  'entity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: entityKind('kind').notNull(),
    canonicalName: text('canonical_name').notNull(),
    // Soft merge: loser rows survive and redirect. Chains are flattened at
    // write time — merging B into C repoints every merged_into_id at B.
    mergedIntoId: uuid('merged_into_id'),
    // Attribute values (system + custom), keyed by attribute slug. The
    // registry (attribute table) defines shape; validation happens at write.
    values: jsonb('values').notNull().default({}),
    source: entitySource('source').notNull().default('manual'),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('entity_kind_idx').on(t.kind),
    index('entity_merged_into_idx')
      .on(t.mergedIntoId)
      .where(sql`${t.mergedIntoId} is not null`),
  ],
)

export const aliasKind = pgEnum('alias_kind', [
  'name',
  'domain',
  'email',
  'linkedin',
  'cin',
])

export const aliasSource = pgEnum('alias_source', [
  'manual',
  'gmail',
  'apollo',
  'import',
  'clip',
  'merge',
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
    source: aliasSource('source').notNull().default('manual'),
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
    reason: jsonb('reason').notNull(),
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
 * list_entry collisions. Captured at merge time or never.
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
  snapshot: jsonb('snapshot').notNull(),
  unmergedAt: timestamp('unmerged_at', { withTimezone: true }),
})

export const linkRelation = pgEnum('link_relation', [
  'mentions',
  'tagged_in',
  'evidence_for',
  'evidence_against',
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
 * evidence_for / evidence_against is the thesis differentiator.
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
