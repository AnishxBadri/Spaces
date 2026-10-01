import { Enqueue } from '@spaces/core/queue/enqueue'
import { enqueue } from '#/lib/queue'
import type { Layer } from 'effect'

/**
 * The web process's `Enqueue` (SPA-201, sdk-8a): core's queue service over
 * `#/lib/queue`'s lazy sender, for the core write paths a web caller runs —
 * document birth's post-commit extraction enqueue above all. The worker
 * builds its own from its connection string (`workerEnqueue`); this one
 * reads `DATABASE_URL` the way `#/lib/queue` always has, on the first send.
 *
 * Its own module rather than an export of `#/lib/queue`, and calling
 * `enqueue` through the import at send time: a test that stubs the queue
 * (`vi.mock('#/lib/queue', () => import('#/test/queue-stub'))`) then records
 * what birth sent with no change to the stub, exactly as it did when birth
 * imported `enqueue` itself.
 */
export const webEnqueue: Layer.Layer<Enqueue> = Enqueue.fromSender({
  enqueue: (queue, data, options) => enqueue(queue, data, options),
})
