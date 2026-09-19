import { createFileRoute } from '@tanstack/react-router'
import {
  STALE_AFTER,
  WORKER_ROLE,
  classifyBeat,
  pingDb,
  readLastBeat,
} from '#/db/heartbeat'

/**
 * The compose/Docker healthcheck for `ROLE=web` and `ROLE=all` (CONTEXT.md
 * hostability contract 4). Unauthenticated, so the payload is deliberately
 * thin: a status, whether the database answers, and how long ago the worker
 * last beat. No pid, no instance, no version — those live in the
 * `worker_heartbeat` row for the operator who can read the table.
 *
 * The overall status and the HTTP code are driven by the database alone.
 * A stale or absent worker is still 200/'ok', because a worker-only outage
 * must never fail a healthy web container's HEALTHCHECK and restart it; the
 * worker's own container answers for the worker (src/worker/health.ts).
 * Postgres being down is the only 503.
 */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        // Both reads return a value on every path, so the heartbeat read
        // cannot throw on the way to reporting an unreachable database.
        const dbOk = await pingDb()
        const worker = classifyBeat(
          await readLastBeat(WORKER_ROLE),
          new Date(),
          STALE_AFTER,
        )

        if (!dbOk) {
          return Response.json(
            { status: 'degraded', db: 'unreachable', worker },
            { status: 503 },
          )
        }
        return Response.json({ status: 'ok', db: 'ok', worker })
      },
    },
  },
})
