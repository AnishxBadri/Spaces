import { Effect } from 'effect'
import { createSender } from '@spaces/core/queue/sender'
import { requireEnv } from './server/env'
import type { EnqueueTarget } from '@spaces/core/queue/names'
import type {
  EnqueueOptions,
  QueuedJob,
  Sender,
} from '@spaces/core/queue/sender'

export type { EnqueueOptions, QueuedJob }

/**
 * The web process's sender. Everything the seam does lives in
 * @spaces/core/queue/sender — sending only, housekeeping off, an enqueue that
 * resolves instead of throwing when the queue is unreachable. What is left
 * here is the one thing core may not do: read the environment.
 *
 * Lazily, and once. Module scope would make DATABASE_URL a condition of
 * importing anything that can file a document; the first enqueue is early
 * enough, and the sender's own retry means a boot with Postgres down is not
 * a permanently dead singleton.
 */

let sender: Sender | null = null

function senderOrNull(queue: EnqueueTarget): Sender | null {
  try {
    sender ??= createSender({ connectionString: requireEnv('DATABASE_URL') })
    return sender
  } catch (err) {
    // An unset DATABASE_URL answers `null` like any other queue failure: a
    // misconfigured deployment must not turn a completed upload into a 500.
    console.error(`[queue] could not reach ${queue}`, err)
    return null
  }
}

/**
 * Onto a core queue, or a plugin job's `plugin.<id>.<job>`. Never fails: a
 * job that could not be sent answers `null`.
 */
export const enqueueProgram = Effect.fn('enqueueProgram')(function* (
  queue: EnqueueTarget,
  data: Record<string, unknown>,
  options?: EnqueueOptions,
) {
  const s = senderOrNull(queue)
  if (s === null) return null
  return yield* Effect.promise(() =>
    options === undefined
      ? s.enqueue(queue, data)
      : s.enqueue(queue, data, options),
  )
})

/** `enqueueProgram` for a caller that is not Effect. */
export async function enqueue(
  queue: EnqueueTarget,
  data: Record<string, unknown>,
  options?: EnqueueOptions,
): Promise<string | null> {
  return Effect.runPromise(enqueueProgram(queue, data, options))
}

/**
 * The jobs on `queue` keyed `key`, any state, or `null` when the queue cannot
 * be read (what `readDeckStatus` reads).
 */
export const jobsByKeyProgram = Effect.fn('jobsByKeyProgram')(function* (
  queue: EnqueueTarget,
  key: string,
) {
  const s = senderOrNull(queue)
  if (s === null) return null
  return yield* Effect.promise(() => s.jobsByKey(queue, key))
})

/** `jobsByKeyProgram` for a caller that is not Effect. */
export async function jobsByKey(
  queue: EnqueueTarget,
  key: string,
): Promise<Array<QueuedJob> | null> {
  return Effect.runPromise(jobsByKeyProgram(queue, key))
}
