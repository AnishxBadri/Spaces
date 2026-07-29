import {
  index,
  jsonb,
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
 * Attio-inspired list/entry primitive: pipeline data lives on list
 * membership, not on the company. Same company sits in "Q3 Pipeline"
 * (stage: diligence) and "Portfolio" (ownership: 4.2%) at once.
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

// Shares the engine's type enum — one type menu everywhere.
import { attributeType } from './attributes'

export const listAttribute = pgTable(
  'list_attribute',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listId: uuid('list_id')
      .notNull()
      .references(() => list.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    type: attributeType('type').notNull(),
    // select/status option definitions, currency code, reference target kind…
    options: jsonb('options').notNull().default({}),
  },
  (t) => [uniqueIndex('list_attribute_slug_unique').on(t.listId, t.slug)],
)

/**
 * values is jsonb keyed by attribute slug. Indexing strategy for kanban
 * group-by/sort (expression indexes at attribute-create time vs GIN) is an
 * open question in CONTEXT.md — decide before the table component is built.
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
    values: jsonb('values').notNull().default({}),
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

/** Typed attribute-change log — stage history for free, feeds analytics. */
export const listEntryEvent = pgTable(
  'list_entry_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => listEntry.id),
    attr: text('attr').notNull(),
    from: jsonb('from'),
    to: jsonb('to'),
    actorId: text('actor_id').references(() => user.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('list_entry_event_entry_idx').on(t.entryId)],
)
