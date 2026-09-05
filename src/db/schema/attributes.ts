import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { entity } from './entities'
import { objectDef } from './objects'
import { user } from './auth'

/**
 * The attribute engine (CONTEXT.md "Attribute engine"). Every object — core
 * or custom — carries a registry of attributes keyed by object_id; ALL
 * values (system and custom) live in entity.values jsonb keyed by slug.
 * Identity, kind, canonical_name never enter this system.
 */

/** Fixed menu — users define attributes, never types. */
export const attributeType = pgEnum('attribute_type', [
  'text',
  'number',
  'currency',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'status',
  'domain',
  'email',
  'url',
  'phone',
  'rating',
  'record_reference',
  'actor_reference',
])

export const attribute = pgTable(
  'attribute',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objectDef.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    type: attributeType('type').notNull(),
    /**
     * Per-type config: select/multi_select/status → {options: [{id, label,
     * color?, group?}]} (status groups: active|parked|closed);
     * record_reference → {targetKind, multi, required};
     * currency → {code}; rating → {max}.
     */
    options: jsonb('options').notNull().default({}),
    // System attrs ship with the product: non-deletable, archivable only.
    // Their *options* stay editable — structure fixed, content free.
    isSystem: boolean('is_system').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('attribute_object_slug_unique').on(t.objectId, t.slug)],
)

/**
 * Per-attribute change history — one row per changed attribute, written in
 * the same transaction as the value write. Deal stage history is
 * `attr_slug = 'stage'`. Timeline condenses bursts at read time.
 */
export const attributeEvent = pgTable(
  'attribute_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    attrSlug: text('attr_slug').notNull(),
    from: jsonb('from'),
    to: jsonb('to'),
    actorId: text('actor_id').references(() => user.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attribute_event_entity_idx').on(t.entityId, t.at),
    index('attribute_event_slug_idx').on(t.entityId, t.attrSlug),
  ],
)
