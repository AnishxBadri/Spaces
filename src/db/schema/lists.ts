import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { entity } from './entities'
import { user } from './auth'

/**
 * Explicit list membership — the surviving half of the Attio list/entry
 * primitive. The other half (values that belong to a membership, and their
 * history) was rejected: a record is one row, a list is a view over rows.
 * Saved filters live in `view`; this is for the rare list someone curates by
 * hand. Deferred from MVP; deals are the pipeline.
 */

export const listKind = pgEnum('list_kind', [
  'pipeline',
  'portfolio',
  'watchlist',
])

export const list = pgTable('list', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: listKind('kind').notNull().default('pipeline'),
  createdBy: text('created_by').references(() => user.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/**
 * Membership, once. Lists are views and records are unique (CONTEXT.md
 * "Lists — deferred", 2026-09-07): an entry says a record is in a list and
 * nothing more — no entry-owned values, no per-list stage. Anything worth
 * saying about the record is an attribute on the record.
 */
export const listEntry = pgTable(
  'list_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listId: uuid('list_id')
      .notNull()
      .references(() => list.id),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    ownerId: text('owner_id').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One entry per (list, entity) — merge collision policy depends on this.
    uniqueIndex('list_entry_unique').on(t.listId, t.entityId),
    index('list_entry_entity_idx').on(t.entityId),
  ],
)
