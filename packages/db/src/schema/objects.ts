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
 * The two keys a custom object may declare as identity (spec §9, CONTEXT.md
 * "Two-tier object model", 2026-09-19). `email` and `cin` are core doctrine —
 * the free-mail and role-prefix rules are about people and companies and mean
 * nothing on a bag — so they are refused rather than listed here.
 */
export type IdentityKey = 'domain' | 'linkedin'

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
    /**
     * Opt-in identity (spec §9). Declaring a key materializes its backing
     * attribute in the same transaction — slug `domain` type `domain`, slug
     * `linkedin` type `url`, carrying `options.identityKey` so the write path
     * finds it without guessing. Empty for every core object: their identity
     * is core-owned and lives in `entity_alias`, not here.
     */
    identityKeys: text('identity_keys')
      .array()
      .$type<Array<IdentityKey>>()
      .notNull()
      .default([]),
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
