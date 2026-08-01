import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { note } from './kinds'

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

export const mandateStatus = pgEnum('mandate_status', ['active', 'archived'])

/**
 * The mandate — the fund's prescriptive strategy (CONTEXT.md, 2026-08).
 * Prose lives in a real note (search, mentions, future AI screening all come
 * free); the few typed columns are the objective measures. Deliberately NOT
 * the attribute engine: one row, a registry buys nothing. `stages` holds
 * option ids from the company funding_stage vocabulary. One active mandate
 * per workspace — archived rows are prior vintages.
 */
export const mandate = pgTable(
  'mandate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: mandateStatus('status').notNull().default('active'),
    noteEntityId: uuid('note_entity_id')
      .notNull()
      .references(() => note.entityId),
    stages: text('stages').array().notNull().default([]),
    geos: text('geos').array().notNull().default([]),
    // Whole currency units — a check size is "₹80L–2Cr", not paise.
    checkMin: bigint('check_min', { mode: 'number' }),
    checkMax: bigint('check_max', { mode: 'number' }),
    currency: text('currency'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('mandate_one_active')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
  ],
)
