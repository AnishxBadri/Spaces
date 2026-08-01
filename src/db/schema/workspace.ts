import { sql } from 'drizzle-orm'
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

/**
 * The workspace singleton — one deployment, one workspace, one row.
 *
 * This is an anchor for identity (sidebar name), the mandate, and
 * credential(scope: 'workspace'), which otherwise reference a ghost. It is
 * NOT a tenancy boundary: the hard rule (CONTEXT.md, 2026-08) is that no
 * other table ever grows a workspace_id FK — the moment one appears, the
 * no-multi-tenancy decision is being relitigated by accident. The CHECK
 * constraint makes the singleton structural rather than remembered.
 */
export const workspace = pgTable(
  'workspace',
  {
    id: integer('id').primaryKey().default(1),
    name: text('name').notNull(),
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check('workspace_singleton', sql`${t.id} = 1`)],
)
