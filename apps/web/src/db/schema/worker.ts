import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * One row per worker role, upserted on boot and every 15s
 * (spec-plugin-sdk §10; CONTEXT.md hostability contract 4). `/api/health`
 * answers "is the database up"; this row is what lets it also answer "is the
 * background worker running", which is the failure that otherwise looks
 * healthy while extraction silently never runs.
 *
 * The key is `role`, not `instance`. One worker per role is what self-host
 * runs, so a role key makes idempotence across restarts structural rather
 * than dependent on a stable container name — restart the worker three times
 * and there is still exactly one row. When multiple instances per role ever
 * matter the key widens to (role, instance) without changing the reader's
 * question.
 *
 * `instance` and `pid` are stored for the operator reading the table, never
 * served: `/api/health` is unauthenticated, so the response carries only a
 * status and an age.
 *
 * Nothing here references an entity, so there is no ENTITY_REFS entry —
 * `entity-refs.test.ts` staying green is the proof.
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
