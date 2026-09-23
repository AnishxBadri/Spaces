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
import type { AiSensitivity } from './ai'
import { note } from './kinds'
import type { Json } from '../json'

/**
 * Workspace-scoped keys. The index signature keeps the column honest about
 * the rest rather than pretending the set is closed.
 *
 * `sensitivity_default` (SPA-61) is the floor `resolveSensitivity` ORs every
 * record's own, space and binding inputs over; absent reads as `'normal'`.
 *
 * `ai_caps` (SPA-73) is the workspace's AI token cap — `daily_tokens` per
 * UTC day and `per_run_tokens` per call, each absent for no cap on that
 * axis; the key absent is no cap at all. `@spaces/core/ai/caps` is the
 * predicate that reads it.
 *
 * `embedding` (SPA-51) is the workspace's embedding pin — the provider and
 * model every vector is made with, the width they all have, and when it was
 * set; the key absent is no embedding model, and search is lexical only.
 * `apps/web/src/lib/ai/embedding-pin.ts` writes it; since SPA-136 it moves
 * to another model of the same width (the backfill re-embeds) and refuses a
 * change of width — that re-pin (ALTER COLUMN TYPE, index rebuild, full
 * re-embed) is not built.
 */
export type AiCapsSetting = {
  daily_tokens?: number
  per_run_tokens?: number
}

export type EmbeddingPinSetting = {
  provider: string
  model: string
  dims: number
  /** ISO instant. */
  pinned_at: string
}

export type WorkspaceSettings = {
  base_currency?: string
  sensitivity_default?: AiSensitivity
  ai_caps?: AiCapsSetting
  embedding?: EmbeddingPinSetting
} & { [k: string]: Json | undefined }

/**
 * The workspace singleton — one deployment, one workspace, one row.
 *
 * This is an anchor for identity (sidebar name), the mandate, and
 * credential(scope: 'workspace'), which otherwise reference a ghost.
 *
 * The old hard rule — "NOT a tenancy boundary; no other table ever grows a
 * workspace_id FK" (CONTEXT.md, 2026-08) — was RESCINDED 2026-08-15 by the
 * owner's multi-workspace reversal: one install holds N workspaces (books)
 * and the user account is the only global object. This singleton is the
 * current build state, not the target shape; the CHECK and the magic id = 1
 * go away when multi-workspace lands (no deployments exist, no upgrade path
 * is owed). The CHECK
 * constraint makes the singleton structural rather than remembered.
 */
export const workspace = pgTable(
  'workspace',
  {
    id: integer('id').primaryKey().default(1),
    name: text('name').notNull(),
    settings: jsonb('settings')
      .$type<WorkspaceSettings>()
      .notNull()
      .default({}),
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
