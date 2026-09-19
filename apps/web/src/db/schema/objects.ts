import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'

/**
 * The object registry — one registry, system rows (CONTEXT.md "Two-tier
 * object model"). Core objects (company/person/deal) are seeded is_system
 * rows; user-created custom objects are ordinary rows. The attribute
 * registry and entity.object_id key on this table; entity.kind stays the
 * machinery dispatch switch (merge/resolution/side tables) and never
 * branches on custom object identity.
 */
export const objectDef = pgTable(
  'object',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Derived from the plural at creation, immutable, never shown in UI.
    slug: text('slug').notNull(),
    singular: text('singular').notNull(),
    plural: text('plural').notNull(),
    icon: text('icon'),
    // System objects ship with the product: non-deletable, never archivable.
    isSystem: boolean('is_system').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('object_slug_unique').on(t.slug)],
)
