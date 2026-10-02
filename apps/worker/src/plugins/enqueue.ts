import { Effect, Layer } from 'effect'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { createSender } from '@spaces/core/queue/sender'
import type { QueueClientFactory } from '@spaces/core/queue/sender'

/**
 * The worker's `Enqueue`: what a plugin port's handed-back work —
 * `Identity.resolve`'s `reembed`, the extraction enqueue — is sent through
 * when the port runs here. Built on core's `createSender`, so the port path
 * never reaches web's `#web/lib/queue` (the test pins it).
 *
 * - Scoped: the sender's pg-boss pool is opened on the first send and closed
 *   when the scope that built this Layer closes. `makePluginHost` builds it
 *   once in its own scope, so every job shares one pool.
 */
export const workerEnqueue = (
  connectionString: string,
  client?: QueueClientFactory,
): Layer.Layer<Enqueue> =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() =>
        createSender({
          connectionString,
          ...(client === undefined ? {} : { client }),
        }),
      ),
      (sender) => Effect.promise(() => sender.close()),
    ).pipe(Effect.map((sender) => Enqueue.fromSender(sender))),
  )
