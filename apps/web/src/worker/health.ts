import { db } from '#/db'
import {
  STALE_AFTER,
  WORKER_ROLE,
  classifyBeat,
  readLastBeat,
} from '#/db/heartbeat'

/**
 * The `ROLE=worker` container's HEALTHCHECK (SPA-57; CONTEXT.md hostability
 * contract 4). A worker-only container runs no HTTP server, so wget-ing
 * :3000 is the wrong check for it — it asks its own `worker_heartbeat` row
 * instead, which is the same row `/api/health` reports and is written by the
 * process this check is really about.
 *
 * Exit 0 when the row is fresh, non-zero when it is stale, missing, or
 * unreadable. No pg-boss: this starts a connection, runs one select, and
 * exits, because Docker runs it every 30s for the life of the container.
 */
async function main(): Promise<void> {
  const worker = classifyBeat(
    await readLastBeat(WORKER_ROLE),
    new Date(),
    STALE_AFTER,
  )
  await db.$client.end()

  if (worker.status === 'ok') {
    console.log(
      `[health] worker beat ${String(worker.lastBeatSeconds)}s ago (stale after ${String(STALE_AFTER)}s)`,
    )
    process.exit(0)
  }

  if (worker.status === 'stale') {
    console.error(
      `[health] worker last beat was ${String(worker.lastBeatSeconds)}s ago, stale after ${String(STALE_AFTER)}s`,
    )
    process.exit(1)
  }

  console.error(
    `[health] no heartbeat row for role '${WORKER_ROLE}' — the worker has never beaten, or the database is unreachable`,
  )
  process.exit(1)
}

main().catch((err) => {
  console.error('[health] check failed', err)
  process.exit(1)
})
