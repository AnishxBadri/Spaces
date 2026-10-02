import { createSender } from '@spaces/core/queue/sender'
import { requireEnv } from './server/env'
import type { EnqueueTarget, QueueName } from '@spaces/core/queue/names'
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
    // An unset DATABASE_URL used to surface as a rejected connect promise
    // inside the sender and so came back as `null` like any other queue
    // failure. It is read out here now, so the same answer is given here —
    // a misconfigured deployment must not turn a completed upload into a 500.
    console.error(`[queue] could not reach ${queue}`, err)
    return null
  }
}

/** Onto a core queue, or a plugin job's `plugin.<id>.<job>`. */
export async function enqueue(
  queue: EnqueueTarget,
  data: Record<string, unknown>,
  options?: EnqueueOptions,
): Promise<string | null> {
  const s = senderOrNull(queue)
  if (s === null) return null
  return options === undefined
    ? s.enqueue(queue, data)
    : s.enqueue(queue, data, options)
}

/**
 * The jobs on `queue` keyed `key`, any state, or `null` when the queue cannot
 * be read (SPA-90's `readDeckStatus`).
 */
export async function jobsByKey(
  queue: QueueName,
  key: string,
): Promise<Array<QueuedJob> | null> {
  const s = senderOrNull(queue)
  if (s === null) return null
  return s.jobsByKey(queue, key)
}
