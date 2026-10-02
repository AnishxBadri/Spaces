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
 * Interaction graph. Relationship intelligence is a live query over
 * interaction_entity weighted by recency + frequency.
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
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id),
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
