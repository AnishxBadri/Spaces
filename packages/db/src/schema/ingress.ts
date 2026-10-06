import { index, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { bytea } from './helpers'
import { integration } from './integrations'

/**
 * Header name → value, lowercased, as the webhook request carried them,
 * minus `cookie` and `authorization`.
 */
export type IngressHeaders = { [name: string]: string }

/**
 * One webhook delivery web verified and accepted, stored raw before its job
 * was enqueued (spec-plugin-sdk §11, Ingress).
 * - `body` is the exact bytes the signature was computed over.
 * - Pruned on a fixed retention by the `ingress.prune` job; the job a
 *   delivery enqueues is handed the payload itself, never this row.
 * - No entity reference: what a payload is about is the plugin's to say.
 */
export const ingressPayload = pgTable(
  'ingress_payload',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integration.id),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    headers: jsonb('headers').$type<IngressHeaders>().notNull(),
    body: bytea('body').notNull(),
  },
  (t) => [
    index('ingress_payload_received_idx').on(t.receivedAt),
    index('ingress_payload_integration_idx').on(t.integrationId, t.receivedAt),
  ],
)
