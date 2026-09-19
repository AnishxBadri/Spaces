import {
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
import { entity } from './entities'
import type { Json } from '#/lib/json'

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

/**
 * Which lane produced the interaction (integration map, CONTEXT.md). A
 * Calendar meeting, a Fireflies transcript, and a WhatsApp export are
 * different evidence with different trust; the timeline and relationship
 * scoring need to tell them apart.
 */
export const interactionSource = pgEnum('interaction_source', [
  'manual',
  'email_sync',
  'forwarding',
  'calendar',
  'recorder',
  'whatsapp',
  'import',
])

export const interaction = pgTable(
  'interaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: interactionKind('kind').notNull(),
    source: interactionSource('source').notNull().default('manual'),
    // RFC822 Message-ID — dedupe across mailboxes: same thread in both
    // partners' inboxes must be one interaction.
    messageId: text('message_id'),
    threadId: text('thread_id'),
    subject: text('subject'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('interaction_message_id_unique').on(t.messageId),
    index('interaction_thread_idx').on(t.threadId),
    index('interaction_occurred_idx').on(t.occurredAt),
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
