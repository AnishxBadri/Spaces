import { db } from '@spaces/db'
import { BEAT_EVERY_MS, WORKER_ROLE, beat } from '@spaces/db/heartbeat'
import type { BeatIdentity } from '@spaces/db/heartbeat'

/**
 * The worker's half of the heartbeat: one row, upserted on boot and every 15s,
 * so a `ROLE=worker` container and `/api/health` can check more than "the
 * process exists".
 * - A failed beat is never fatal: the row goes stale and the next tick heals
 *   it. An unhandled rejection here would kill the container over monitoring.
 */
export function workerIdentity(): BeatIdentity {
  return {
    role: WORKER_ROLE,
    // Compose and Kubernetes both set HOSTNAME to the container/pod name;
    // `pnpm worker` on a laptop gets the constant.
    instance: process.env.HOSTNAME ?? 'worker',
    pid: process.pid,
    bootedAt: new Date(),
  }
}

export interface Heartbeat {
  /** Resolves once the boot beat has been attempted. */
  readonly booted: Promise<void>
  /** Idempotent; called from the SIGTERM path so the process can exit. */
  readonly stop: () => void
}

export function startHeartbeat(identity: BeatIdentity): Heartbeat {
  // The heartbeat brings the drizzle pool into this process, so it owns the
  // pool's 'error' event. node-postgres re-emits an idle client's error on the
  // pool (`terminating connection due to administrator command` on every
  // Postgres restart), and an 'error' with no listener is an uncaught throw:
  // without this line a database restart would kill the container.
  db.$client.on('error', (err: Error) => {
    console.error('[worker] heartbeat pool error', err.message)
  })

  const tick = async () => {
    try {
      await beat(identity)
    } catch (err) {
      console.error('[worker] heartbeat failed', err)
    }
  }

  const timer = setInterval(() => void tick(), BEAT_EVERY_MS)
  // The heartbeat must never be the reason the process stays alive; pg-boss
  // is what holds the event loop open.
  timer.unref()

  return {
    booted: tick(),
    stop: () => clearInterval(timer),
  }
}
