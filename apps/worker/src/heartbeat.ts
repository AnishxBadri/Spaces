import { db } from '@spaces/db'
import { BEAT_EVERY_MS, WORKER_ROLE, beat } from '@spaces/db/heartbeat'
import type { BeatIdentity } from '@spaces/db/heartbeat'

/**
 * The worker's half of the heartbeat (SPA-57). One row, upserted on boot and
 * every 15s, so a `ROLE=worker` container and `/api/health` both have
 * something to check other than "the process exists".
 *
 * A failed beat is never fatal. Postgres blinking should not kill the worker
 * — the beat simply does not land, the row goes stale on its own, and the
 * next tick heals it. An unhandled rejection here would be a container death
 * (hostability contract 2) caused by the monitoring, which is worse than the
 * thing it monitors.
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
  // The heartbeat is what brings a drizzle pool into the worker process, so
  // the heartbeat owns that pool's 'error' event. node-postgres re-emits an
  // idle client's error on the pool — `terminating connection due to
  // administrator command` every time Postgres restarts — and an
  // EventEmitter 'error' with no listener is an uncaught throw. Without this
  // line the monitoring is the reason the container dies, on nothing worse
  // than a database restart the pool recovers from by itself.
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
