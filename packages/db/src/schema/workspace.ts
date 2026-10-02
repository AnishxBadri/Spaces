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
 * - `sensitivity_default`: the floor `resolveSensitivity` ORs every record's
 *   own, space and binding inputs over; absent reads as `'normal'`.
 * - `ai_caps`: `daily_tokens` per UTC day and `per_run_tokens` per call, each
 *   absent for no cap on that axis; the key absent is no cap at all. Read by
 *   `capsFromSettings`.
 * - `embedding`: the pin — provider, model, the width every vector has, and
 *   when it was set; absent means no embedding model and lexical-only search.
 *   `pinEmbeddingProgram` moves it to another model of the same width (the
 *   backfill re-embeds) and refuses a change of width — that re-pin (ALTER
 *   COLUMN TYPE, index rebuild, full re-embed) is not built.
 * - `embedding.sensitive` (D11): a second, local provider at the pin's width
 *   that a sensitive embed routes to when the pin is a cloud provider. Absent,
 *   a sensitive embed is refused and the record is left unembedded. It lives
 *   inside `embedding` so a pin swap merges into the object, not replaces it.
 */
export type AiCapsSetting = {
  daily_tokens?: number
  per_run_tokens?: number
}

export type EmbeddingSlotSetting = {
  provider: string
  model: string
  dims: number
  /** ISO instant. */
  set_at: string
}

export type EmbeddingPinSetting = {
  provider: string
  model: string
  dims: number
  /** ISO instant. */
  pinned_at: string
  sensitive?: EmbeddingSlotSetting
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
 * - Anchors identity (sidebar name), the mandate, and
 *   credential(scope: 'workspace'), which otherwise reference a ghost.
 * - The CHECK constraint makes the singleton structural rather than
 *   remembered.
 * - Not the target shape: one install holds N workspaces, and the CHECK and
 *   magic id = 1 go away then (CONTEXT.md, "Single user first, team ready").
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
 * The mandate — the fund's prescriptive strategy (CONTEXT.md, "Mandate").
 * - Prose lives in a real note; the few typed columns are the objective
 *   measures. Not the attribute engine: one row, a registry buys nothing.
 * - `stages` holds option ids from the company funding_stage vocabulary.
 * - One active mandate per workspace — archived rows are prior vintages.
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
