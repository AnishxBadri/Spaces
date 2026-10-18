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

/**
 * A call's state. `unmounted`: a plugin's tool held back before any call,
 * because the turn's scope is sensitive. (D72)
 */
export type AskCallState =
  'running' | 'done' | 'refused' | 'failed' | 'unmounted'

/** The integration a plugin's tool call went through, as the strip marks it. */
export type AskVia = { integrationId: string; name: string }

/** Where a found company stands, as it was read when shown. */
export type AskFindStanding = 'filed' | 'held' | 'unknown'

/** One company a find turned up: a web result until it is added. (D77) */
export type AskFindRow = {
  name: string
  /** Normalized; the row's key within its table. */
  domain: string
  /** What it does, in a line. */
  line: string
  place: string | null
  /** The pages it was found on: one to three, each one a plugin call returned. */
  sources: ReadonlyArray<{ url: string; title?: string }>
  via: AskVia
  standing: AskFindStanding
  /** The record it is held as; null while unknown. */
  entityId: string | null
}

/**
 * A find's results table. `space` is the turn's space chip, which Add and
 * file, File here and Dismiss act on; null with none in scope.
 */
export type AskFindTable = {
  space: { id: string; name: string } | null
  rows: ReadonlyArray<AskFindRow>
  /** Rows left out because their domain is dismissed from the space. */
  hidden: number
}

/** The action cards Ask proposes; the catalogue in `ASK_CARD_CATALOGUE`. (D70) */
export type AskCardKind =
  | 'task'
  | 'move_stage'
  | 'file_into_space'
  | 'log_signal'
  | 'note'
  | 'draft_email'
  | 'add_record'
  | 'save_as_watch'

/**
 * An action card a call proposed, frozen as proposed. The card itself is the
 * open `suggestion` row it names; its outcome is read from that row.
 */
export type AskCallCard = {
  kind: AskCardKind
  suggestionId: string
  record: { id: string; name: string; href: string | null }
  /** The proposal in a line: the task title, `Diligence → Term sheet`, a space path. */
  summary: string
  /** The evidence the card cites, labelled as the turn read it. */
  evidence: ReadonlyArray<AskRef>
  /** `move_stage`: the stage id the deal held when proposed; null when none. */
  from?: string | null
}

/** One tool call of a turn, as the call strip prints it. */
export type AskCall = {
  tool: string
  state: AskCallState
  /** What was asked, in a few words: the query, the object, the record. */
  input: string
  /** How many things it found; null when the tool counts nothing. */
  found: number | null
  /** The card a `propose_card` call left, once stored with the answer. */
  card?: AskCallCard
  /** Why a refused call was refused, when the reader is owed a sentence. */
  reason?: string
  /** A plugin's tool: the integration it went through. */
  via?: AskVia
  /** The results table a `show_companies` call left. */
  find?: AskFindTable
}

export const askTurnRole = pgEnum('ask_turn_role', ['user', 'assistant'])

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
