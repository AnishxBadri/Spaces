import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { user } from './auth'
import { entity, sourceClass } from './entities'
import { integration } from './integrations'
import { document, note } from './kinds'
import type { Json } from '../json'

/**
 * Interaction graph. Relationship intelligence is a live query over
 * interaction_entity weighted by recency + frequency.
 */

export const interactionKind = pgEnum('interaction_kind', [
  'email',
  'meeting',
  'call',
])

export type InteractionKind = (typeof interactionKind.enumValues)[number]

/**
 * `interaction.meta` for an email: its headers (D67). `mime_blob_sha` is the
 * content address of the stored raw MIME, null until it is kept.
 */
export type EmailMeta = {
  kind: 'email'
  from: string
  to: Array<string>
  cc: Array<string>
  /** The `Date` header, as an ISO instant. */
  date: string
  mime_blob_sha: string | null
  /** The mailbox's labels by name, for a synced message; the exclude list reads them. */
  labels?: Array<string>
}

export type MeetingStatus = 'scheduled' | 'cancelled'

export type MeetingRsvp = 'accepted' | 'declined' | 'tentative' | 'needs_action'

/**
 * `interaction.meta` for a meeting (D68). Calendar sync rewrites it in place;
 * a cancelled meeting is marked, never deleted.
 */
export type MeetingMeta = {
  kind: 'meeting'
  /** ISO instant; `occurred_at` is the start. */
  ends_at: string
  status: MeetingStatus
  conference_url: string | null
  /** The organizer's email. */
  organizer: string | null
  recurring_instance_id: string | null
  /** Participant email → their answer. Shown, never edited. */
  rsvp: { [email: string]: MeetingRsvp }
  /**
   * The calendar's own id for the event: how a deleted event, which may name
   * nothing else, finds its row.
   */
  calendar_event_id?: string
  /** Recorder payloads attached to this meeting, one per provider event (D68). */
  recorder_events?: Array<RecorderEvent>
}

/** A recorder payload on a row: the provider's id for it and its receipt. */
export type RecorderEvent = {
  provider_event_id: string
  /** The `enrichment_record` holding the payload whole. */
  receipt_id: string
}

/** `interaction.meta` for a call a recorder births (D68). */
export type CallMeta = {
  kind: 'call'
  provider_event_id: string
  duration_seconds: number | null
  /** The `enrichment_record` holding the payload whole. */
  receipt_id?: string
}

/**
 * Per-kind metadata, keyed by `kind`, which always equals the row's own
 * `interaction.kind`. The decoder is `readInteractionMeta` in
 * `@spaces/core/json`; it refuses a shape whose `kind` is not the row's.
 */
export type InteractionMeta = EmailMeta | MeetingMeta | CallMeta

export const interaction = pgTable(
  'interaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: interactionKind('kind').notNull(),
    /**
     * Which lane produced the interaction — as a class, and the vendor as a
     * row: `source_ref` names the installed integration, not a product
     * category. Not a vendor-named enum, which a plugin would have to ALTER to
     * say it wrote a row. (CONTEXT.md "Interactions and enrichment")
     */
    sourceClass: sourceClass('source_class').notNull().default('manual'),
    /** The integration that wrote the row; null for every other class. */
    sourceRef: uuid('source_ref').references(() => integration.id),
    // RFC822 Message-ID — dedupe across mailboxes: same thread in both
    // partners' inboxes must be one interaction.
    messageId: text('message_id'),
    threadId: text('thread_id'),
    subject: text('subject'),
    /**
     * The interaction's write-up, as a real note row; the structured event
     * stays here. (CONTEXT.md "Interactions and enrichment")
     * - Nullable, and lazily filled: a call logged with nothing written must
     *   not manufacture an empty note row. "Log and write up" sets it.
     * - `interaction_note_unique` stops two interactions claiming one body.
     */
    noteId: uuid('note_id').references(() => note.entityId),
    /** Per-kind metadata (D67, D68); null when the lane has none. */
    meta: jsonb('meta').$type<InteractionMeta>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('interaction_message_id_unique').on(t.messageId),
    // One body, one interaction. Postgres treats NULLs as distinct in a
    // unique index, so this admits any number of write-up-less rows and
    // exactly one interaction per note.
    uniqueIndex('interaction_note_unique').on(t.noteId),
    index('interaction_thread_idx').on(t.threadId),
    index('interaction_occurred_idx').on(t.occurredAt),
    // The same biconditional the entity and alias rows carry: an
    // `integration` row that cannot say which integration wrote it is a
    // provenance hole, and a `manual` row carrying an integration id is a
    // provenance lie. Both directions, one constraint.
    check(
      'interaction_source_ref_invariant',
      sql`(${t.sourceClass} = 'integration') = (${t.sourceRef} IS NOT NULL)`,
    ),
  ],
)

/** The relationship-graph edge table. */
export const interactionEntity = pgTable(
  'interaction_entity',
  {
    interactionId: uuid('interaction_id')
      .notNull()
      .references(() => interaction.id),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
  },
  (t) => [
    primaryKey({ columns: [t.interactionId, t.entityId] }),
    index('interaction_entity_entity_idx').on(t.entityId),
  ],
)

/** The kinds `interaction_stat` keeps a row for: every interaction kind plus `any`. */
export const INTERACTION_STAT_KINDS = [
  ...interactionKind.enumValues,
  'any',
] as const

export type InteractionStatKind = (typeof INTERACTION_STAT_KINDS)[number]

/**
 * First, last and next interaction per entity and kind, derived (D67).
 * - Written only by `recomputeInteractionStats`, in the transaction of the
 *   interaction write that changed it; never edited, never in `entity.values`.
 * - `first`/`last` are uncancelled interactions that have happened; `next` is
 *   the earliest uncancelled meeting still ahead.
 * - `kind` is text, not `interaction_kind`, because `any` is not a kind.
 */
export const interactionStat = pgTable(
  'interaction_stat',
  {
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    kind: text('kind').$type<InteractionStatKind>().notNull(),
    firstId: uuid('first_id').references(() => interaction.id),
    firstAt: timestamp('first_at', { withTimezone: true }),
    lastId: uuid('last_id').references(() => interaction.id),
    lastAt: timestamp('last_at', { withTimezone: true }),
    nextId: uuid('next_id').references(() => interaction.id),
    nextAt: timestamp('next_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.kind] }),
    // The roll's lookup: rows whose next meeting has started.
    index('interaction_stat_next_idx')
      .on(t.nextAt)
      .where(sql`${t.nextAt} is not null`),
    check(
      'interaction_stat_kind_check',
      sql`${t.kind} in (${sql.raw(INTERACTION_STAT_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
  ],
)

/** What a document is to the interaction it hangs off (D68). */
export const interactionDocumentRole = pgEnum('interaction_document_role', [
  'attachment',
  'transcript',
  'recording_link',
])

/**
 * Every artifact of an interaction: an email's attachments, a meeting's
 * transcript and recording link. One meeting, many artifacts — never a
 * `document_id` column on `interaction`. (D67, D68)
 */
export const interactionDocument = pgTable(
  'interaction_document',
  {
    interactionId: uuid('interaction_id')
      .notNull()
      .references(() => interaction.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => document.entityId),
    role: interactionDocumentRole('role').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.interactionId, t.documentId] }),
    index('interaction_document_document_idx').on(t.documentId),
  ],
)

/**
 * Layer two of D67's email privacy: the owner's emails with one record,
 * opened to the workspace ("my emails with Flent are visible to the
 * workspace"). Read by `emailWidenedSql`; removing the row restores privacy
 * and leaves `email_grant` alone.
 * - Covers the emails edged to the record, and on a deal the threads it
 *   derives from its company and contacts (D49).
 * - `scope` has one value today; the check keeps it honest.
 */
export const emailVisibility = pgTable(
  'email_visibility',
  {
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    /** Whose emails: the owner, who alone may set or remove it. */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<'workspace'>().notNull().default('workspace'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.userId] }),
    check('email_visibility_scope_check', sql`${t.scope} = 'workspace'`),
  ],
)

/**
 * Layer three of D67's email privacy: one email's body and attachments
 * opened to one named member, by its owner. Read by `emailWidenedSql`.
 */
export const emailGrant = pgTable(
  'email_grant',
  {
    interactionId: uuid('interaction_id')
      .notNull()
      .references(() => interaction.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    grantedBy: text('granted_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.interactionId, t.userId] })],
)

/** Funding news, patents, hiring — provider-shaped payloads. */
export const signal = pgTable(
  'signal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    source: text('source').notNull(),
    payload: jsonb('payload').$type<Json>().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Who wrote the signal (D57): the same pair `entity` and `entity_alias`
     * carry. `source` stays as the display text; these two are the provenance
     * a plugin cannot forge — `Content.emitSignal` writes the bound
     * integration's id from the port, never from the plugin.
     */
    sourceClass: sourceClass('source_class').notNull().default('manual'),
    sourceRef: uuid('source_ref').references(() => integration.id),
  },
  (t) => [
    index('signal_entity_idx').on(t.entityId),
    // The biconditional `entity_source_ref_invariant` spells, for the
    // same reason: an integration row must say which integration, and no
    // other class may claim one.
    check(
      'signal_source_ref_invariant',
      sql`(${t.sourceClass} = 'integration') = (${t.sourceRef} IS NOT NULL)`,
    ),
  ],
)

/**
 * Raw provider responses, kept whole. Fields are projected out with
 * per-field provenance; a manually-edited field is never overwritten.
 */
export const enrichmentRecord = pgTable(
  'enrichment_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The record the response is about. Null for a recorder's payload: it is
     * about a meeting, which is not a record, and is stored before any
     * participant is resolved. A null row never reads as an enrichment.
     */
    entityId: uuid('entity_id').references(() => entity.id),
    /** Display text: the manifest id of the plugin that fetched it. */
    provider: text('provider').notNull(),
    raw: jsonb('raw').$type<Json>().notNull(),
    creditsUsed: integer('credits_used'),
    /**
     * The integration whose call this is (D57), written by `Receipts.store`
     * from the bound row. Nullable only for legacy rows; the port always
     * sets it.
     */
    integrationId: uuid('integration_id').references(() => integration.id),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('enrichment_entity_idx').on(t.entityId)],
)
