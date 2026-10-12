import { sql } from 'drizzle-orm'
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
import { aiRun } from './ai'
import { user } from './auth'

/**
 * Ask's thread store: one thread per conversation, one row per turn. (D70)
 * - Private to their author and not entities: no `entity` row, no mentions,
 *   no search hits. Every read filters on `ask_thread.user_id`.
 * - A turn is frozen when it is asked: the scope, the calls and the cited
 *   sources with their labels are stored with it, and reopening a thread
 *   reads them back, never the records as they stand now.
 */

/** A scope chip: what a turn was asked about. Null id is the whole workspace. */
export type AskScopeChip = {
  kind: 'record' | 'space' | 'person' | 'view' | 'file' | 'page' | 'web'
  id: string | null
  name: string
  href: string | null
}

/** A source an answer cited, with the words it was shown as at the time. */
export type AskRef = {
  /** `record:<id>`, or a context ref (`note:<id>`, `doc:<id>#3`, …). */
  ref: string
  label: string
  /** The record or note the chip opens; null when it has no page. */
  href: string | null
  /** The entity the ref belongs to, for the lost-access check. */
  entityId: string | null
}

export type AskCallState = 'running' | 'done' | 'refused' | 'failed'

/** One tool call of a turn, as the call strip prints it. */
export type AskCall = {
  tool: string
  state: AskCallState
  /** What was asked, in a few words: the query, the object, the record. */
  input: string
  /** How many things it found; null when the tool counts nothing. */
  found: number | null
}

export const askTurnRole = pgEnum('ask_turn_role', ['user', 'assistant'])
export type AskTurnRole = (typeof askTurnRole.enumValues)[number]

/**
 * Where an answer ended. `streaming` is the birth state; the rest are final.
 * - `refused`: sensitive material and no local route.
 * - `no_provider`: no model is routed or keyed for the lane.
 * - `empty`: nothing was found; the calls say what was searched.
 */
export const askTurnState = pgEnum('ask_turn_state', [
  'streaming',
  'answered',
  'stopped',
  'refused',
  'capped',
  'no_provider',
  'failed',
  'empty',
])
export type AskTurnState = (typeof askTurnState.enumValues)[number]

export const askThread = pgTable(
  'ask_thread',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('ask_thread_user_created_idx').on(t.userId, t.createdAt)],
)

export const askTurn = pgTable(
  'ask_turn',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => askThread.id, { onDelete: 'cascade' }),
    role: askTurnRole('role').notNull(),
    /** The question, or the answer with its `[ref]` citations as written. */
    bodyMd: text('body_md').notNull().default(''),
    refs: jsonb('refs')
      .$type<ReadonlyArray<AskRef>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    calls: jsonb('calls')
      .$type<ReadonlyArray<AskCall>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    scope: jsonb('scope')
      .$type<ReadonlyArray<AskScopeChip>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The answer's run; null on a question, and on an answer refused before any call. */
    aiRunId: uuid('ai_run_id').references(() => aiRun.id),
    /** Null on a question. */
    state: askTurnState('state'),
    /** The answer's foot: the model, or the refusal, as a line. */
    route: text('route'),
    /** When the answer was saved as a note. */
    savedAt: timestamp('saved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ask_turn_thread_created_idx').on(t.threadId, t.createdAt),
    check(
      'ask_turn_state_invariant',
      sql`(${t.role} = 'user') = (${t.state} IS NULL)`,
    ),
  ],
)
