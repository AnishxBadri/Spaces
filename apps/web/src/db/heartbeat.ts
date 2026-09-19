import { eq, sql } from 'drizzle-orm'
import { db } from './index.ts'
import { workerHeartbeat } from './schema/worker.ts'

/**
 * The worker heartbeat, from both ends (SPA-57; spec-plugin-sdk §10;
 * CONTEXT.md hostability contract 4).
 *
 * The worker writes through `beat()`; two readers ask the same question of
 * the same row — the unauthenticated `/api/health` route and the
 * `ROLE=worker` container's own health command (`src/worker/health.ts`),
 * which has no HTTP server to ask. They share this module so the threshold
 * has exactly one definition: `classifyBeat` takes it as an argument and
 * both callers pass `STALE_AFTER`, so a second literal threshold cannot
 * appear without deleting the parameter.
 *
 * Every function here returns a value on every path, including "Postgres is
 * down". That is load-bearing for the route: a worker-only outage must never
 * fail a healthy web container's HEALTHCHECK, and a database outage must not
 * turn the heartbeat read into a throw on the way to reporting it.
 */

/**
 * Seconds. A beat older than this is stale — four missed beats at the 15s
 * interval, which is slack enough for a busy tick and short enough that an
 * operator watching `docker ps` learns within a minute.
 */
export const STALE_AFTER = 60

/** How often the worker upserts its row. */
export const BEAT_EVERY_MS = 15_000

/** The only role that beats today; the column exists so more can. */
export const WORKER_ROLE = 'worker'

export type WorkerStatus = 'ok' | 'stale' | 'absent'

/** What `/api/health` serves under `worker` — no pid, instance or version. */
export interface WorkerHealth {
  readonly status: WorkerStatus
  readonly lastBeatSeconds: number | null
}

/** Pure. `staleAfter` is seconds; `lastBeat` null means no row was found. */
export function classifyBeat(
  lastBeat: Date | null,
  now: Date,
  staleAfter: number,
): WorkerHealth {
  if (lastBeat === null) return { status: 'absent', lastBeatSeconds: null }
  const ageMs = now.getTime() - lastBeat.getTime()
  // Clock skew between the database and the reader can put a beat slightly in
  // the future; a negative age would read as a bug in the payload.
  const lastBeatSeconds = Math.max(0, Math.round(ageMs / 1000))
  return {
    status: lastBeatSeconds > staleAfter ? 'stale' : 'ok',
    lastBeatSeconds,
  }
}

/**
 * The last beat for a role, or null when there is no row *or* the database
 * cannot be reached. Both are "we have no evidence of a worker", and the
 * caller that cares about the difference (the route) has already asked the
 * database directly.
 */
export async function readLastBeat(role: string): Promise<Date | null> {
  try {
    const rows = await db
      .select({ beatAt: workerHeartbeat.beatAt })
      .from(workerHeartbeat)
      .where(eq(workerHeartbeat.role, role))
      .limit(1)
    const row = rows.at(0)
    if (row === undefined) return null
    return row.beatAt
  } catch {
    return null
  }
}

/** `select 1`, as a boolean. Never throws. */
export async function pingDb(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`)
    return true
  } catch {
    return false
  }
}

export interface BeatIdentity {
  readonly role: string
  readonly instance: string
  readonly pid: number
  readonly bootedAt: Date
}

/**
 * Upsert this process's row. `booted_at` is re-asserted on every beat from
 * the value captured at boot, so a restart replaces the previous process's
 * row in place instead of leaving a second one behind.
 */
export async function beat(identity: BeatIdentity): Promise<void> {
  const beatAt = new Date()
  await db
    .insert(workerHeartbeat)
    .values({
      role: identity.role,
      instance: identity.instance,
      pid: identity.pid,
      bootedAt: identity.bootedAt,
      beatAt,
    })
    .onConflictDoUpdate({
      target: workerHeartbeat.role,
      set: {
        instance: identity.instance,
        pid: identity.pid,
        bootedAt: identity.bootedAt,
        beatAt,
      },
    })
}
