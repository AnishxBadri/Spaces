import { Enqueue } from '@spaces/core/queue/enqueue'
import { enqueue } from '#/lib/queue'
import type { Layer } from 'effect'

/**
 * The web process's `Enqueue`: core's queue service over the lazy `enqueue`
 * sender, for core write paths a web caller runs (document birth's
 * post-commit extraction above all). Reads `DATABASE_URL` on the first send.
 * - Its own module, calling `enqueue` through the import at send time, so a
 *   test that `vi.mock`s `#/lib/queue` records what was sent.
 */
export const webEnqueue: Layer.Layer<Enqueue> = Enqueue.fromSender({
  enqueue: (queue, data, options) => enqueue(queue, data, options),
})
