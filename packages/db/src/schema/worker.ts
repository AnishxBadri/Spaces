import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * One row per worker role, upserted on boot and every 15s, so `/api/health`
 * can answer "is the background worker running" (CONTEXT.md, hostability
 * contract 4).
 *
 * - Keyed on `role`, not `instance`: restarts leave exactly one row whatever
 *   the container is named.
 * - `instance` and `pid` are for the operator reading the table, never
 *   served: `/api/health` is unauthenticated, so it carries only status + age.
 */
export const workerHeartbeat = pgTable('worker_heartbeat', {
  role: text('role').primaryKey(),
  /** HOSTNAME inside a container, falling back to 'worker'. */
  instance: text('instance').notNull(),
  pid: integer('pid').notNull(),
  /** When the process currently holding this role started. */
  bootedAt: timestamp('booted_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Last beat. Staleness — not row deletion — is the signal, so a graceful
   * SIGTERM leaves the row and the operator sees when it last beat. */
  beatAt: timestamp('beat_at', { withTimezone: true }).notNull().defaultNow(),
})
