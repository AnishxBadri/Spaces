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
import { entity, sourceClass } from './entities'
import { integration } from './integrations'
import { note } from './kinds'
import type { Json } from '../json'

/**
 * Interaction graph. Gmail sync is post-MVP (forward-only when it lands),
 * but the tables exist from migration one — relationship intelligence is a
 * live query over interaction_entity weighted by recency + frequency.
 */

export const interactionKind = pgEnum('interaction_kind', [
  'email',
  'meeting',
  'call',
])

export const interaction = pgTable(
  'interaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: interactionKind('kind').notNull(),
    /**
     * Which lane produced the interaction — as a class, and the vendor as a
     * row (SPA-137, migration 0030). `interaction_source` named five of them
     * in the type itself (`email_sync`, `forwarding`, `calendar`, `recorder`,
     * `whatsapp`), which is the shape a third-party plugin cannot migrate:
     * a Fireflies plugin would have had to ALTER a shared enum to say it
     * wrote a row. A Calendar meeting and a WhatsApp export are still
     * different evidence with different trust — the difference is now
     * `source_ref`, which names the installed integration rather than the
     * product category.
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
     * The interaction's write-up, as a real note row (CONTEXT.md →
     * "Interactions and enrichment", decided 2026-09-14; built SPA-123).
     * `interaction` never had a body column, so this is the whole of the
     * unification: the structured event keeps kind / occurred_at / attendees
     * and the prose lives in `note`, where one editor, one mention system and
     * one search index already are.
     *
     * **Nullable, and lazily filled.** A call logged in twenty seconds with
     * nothing written should not manufacture an empty note row — the plain
     * "Log meeting" path leaves this null, and "Log and write up" is what
     * sets it. The `interaction_note_unique` index below stops two
     * interactions claiming one body; being partial by nature of a unique
     * index over NULLs, it says nothing about the many bodyless rows.
     */
    noteId: uuid('note_id').references(() => note.entityId),
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
  },
  (t) => [index('signal_entity_idx').on(t.entityId)],
)

/**
 * Raw provider responses, kept whole. Fields are projected out with
 * per-field provenance; a manually-edited field is never overwritten.
 */
export const enrichmentRecord = pgTable(
  'enrichment_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
    provider: text('provider').notNull(),
    raw: jsonb('raw').$type<Json>().notNull(),
    creditsUsed: integer('credits_used'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('enrichment_entity_idx').on(t.entityId)],
)
