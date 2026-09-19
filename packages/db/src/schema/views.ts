import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'
import { visibility } from './kinds'
import { objectDef } from './objects'

/**
 * The payload types of this table's four jsonb columns. They are declared
 * here, at the columns that claim them, rather than in the filter module that
 * evaluates them (`apps/web/src/lib/views/filter.ts`, which re-exports every
 * name below): packages/db imports nothing internal, and a column's type has
 * one home (SPA-142). The evaluator, the op menu and the editor stay in the
 * app — they are readers of this shape, not the shape.
 */

export type ConditionOp =
  'is' | 'is_not' | 'contains' | 'empty' | 'not_empty' | 'gt' | 'lt'

/** What a condition may compare against — JSON scalars, or option ids. */
export type ConditionValue = string | number | boolean | null | Array<string>

export type Condition = {
  slug: string
  op: ConditionOp
  value?: ConditionValue | undefined
}

/** TanStack's single sort, as a view stores it. */
export type ViewSort = { id: string; desc: boolean } | null

/** Page-specific view state; scalars only so it crosses the server seam. */
export type ViewExtra = Record<string, string | number | boolean | null>

/** TanStack VisibilityState — column id → shown. */
export type ViewColumns = Record<string, boolean>

/**
 * A view is a saved way of looking at one object's records (CONTEXT.md
 * "Lists — deferred", 2026-09-07): filter conditions, which columns show,
 * one sort, and any surface-specific extra (the deals stage chips). It
 * holds no values — anything worth saying about a record is an attribute on
 * the record. Keyed on the object row, so core and custom objects get the
 * same thing. Private views belong to their author; shared ones to the
 * workspace.
 */
export const view = pgTable(
  'view',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objectDef.id),
    name: text('name').notNull(),
    // Array<{ slug, op, value? }> — see src/lib/views/filter.ts
    filter: jsonb('filter').$type<Array<Condition>>().notNull().default([]),
    // { id, desc } | null — TanStack's single sort
    sort: jsonb('sort').$type<ViewSort>(),
    // TanStack VisibilityState — column id → shown
    columns: jsonb('columns').$type<ViewColumns>().notNull().default({}),
    // Page-specific state a surface opts into (deals: group/stage chips)
    extra: jsonb('extra').$type<ViewExtra>().notNull().default({}),
    visibility: visibility('visibility').notNull().default('private'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('view_object_idx').on(t.objectId)],
)
