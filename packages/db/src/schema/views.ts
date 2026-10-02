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
import { sql } from 'drizzle-orm'
import { user } from './auth'
import { visibility } from './kinds'
import { objectDef } from './objects'

/**
 * The payload types of this table's four jsonb columns, declared at the
 * columns that claim them: packages/db imports nothing internal, and a
 * column's type has one home. The filter module (`matchesConditions`)
 * re-exports every name; the evaluator, op menu and editor are readers of
 * this shape, not the shape.
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
 * Which list a view is saved against (D2). `object` is a
 * row of the object registry — `object_id` names it. `document` is
 * /documents, a research kind with no object row and no attribute registry,
 * so it carries no `object_id` at all. A third value is a migration to this
 * enum plus a `resolve` branch for its fields, never a registry row: see
 * CONTEXT.md "Lists — deferred" for the rule that admits one.
 */
export const viewSurface = pgEnum('view_surface', ['object', 'document'])

export type ViewSurface = (typeof viewSurface.enumValues)[number]

/**
 * A view is a saved way of looking at one list (CONTEXT.md "Lists —
 * deferred"): filter conditions, which columns show, one sort,
 * and any surface-specific extra (the deals stage chips). It holds no
 * values — anything worth saying about a record is an attribute on the
 * record. `surface` says which list; on the `object` surface `object_id`
 * keys the object row, so core and custom objects get the same thing.
 * Private views belong to their author; shared ones to the workspace.
 */
export const view = pgTable(
  'view',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    surface: viewSurface('surface').notNull(),
    // Null exactly when the surface is not `object` — the check below.
    objectId: uuid('object_id').references(() => objectDef.id),
    name: text('name').notNull(),
    // Array<{ slug, op, value? }> — see `Condition`
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
  (t) => [
    index('view_object_idx').on(t.objectId),
    // The discriminator and the FK are one fact, asserted by the database:
    // an object view names an object, every other surface names none.
    check(
      'view_surface_object_id',
      sql`(${t.surface} = 'object') = (${t.objectId} is not null)`,
    ),
  ],
)
