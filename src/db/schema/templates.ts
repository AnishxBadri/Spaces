import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'

export const templateKind = pgEnum('template_kind', ['note', 'space', 'record'])

/**
 * Templates — one mechanism, three kinds (CONTEXT.md, 2026-08).
 * Standardized *capture*, never automation. Config, not entities: no
 * mentions, no search hits, no graph rows. User-created and
 * workspace-shared; we ship none — a shipped template pre-empts vocabulary.
 * Instantiation is copy, not reference: editing a template never rewrites
 * what it stamped.
 *
 * `body` by kind:
 *  - note   — a BlockNote document (mentions stripped to plain text at save;
 *             a template must not materialize link rows to real entities)
 *  - record — { values: {attr_slug: default} } for one object_kind; never
 *             reference/actor slugs, skipped-if-archived at instantiation
 *  - space  — { terms: [{name, definition}], children: [recursive] } —
 *             names and skeletons only, captured by example from a real
 *             space, stamped skip-existing
 */
export const template = pgTable('template', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: templateKind('kind').notNull(),
  /** Only when kind = record. */
  objectKind: text('object_kind'),
  name: text('name').notNull(),
  body: jsonb('body').notNull(),
  /** Context hint: pickers surface templates tagged for their origin first. */
  suggestOn: text('suggest_on').array().notNull().default([]),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id),
  archived: boolean('archived').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
