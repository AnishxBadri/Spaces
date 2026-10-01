import type { Layer } from 'effect'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { createSender } from '@spaces/core/queue/sender'
import type { QueueClientFactory } from '@spaces/core/queue/sender'

/**
 * The worker's `Enqueue` (sdk-7a): what a plugin port's handed-back work —
 * `Identity.resolve`'s `reembed`, sdk-8a's extraction — is sent through when
 * the port runs here. Built from core's `createSender` on the connection
 * string the worker already boots pg-boss with, so the port path never
 * reaches web's `#web/lib/queue` (`plugins/` imports none; the test pins
 * it). The loader's per-job Layer (sdk-12b) provides it to the ports.
 */
export const workerEnqueue = (
  connectionString: string,
  client?: QueueClientFactory,
): Layer.Layer<Enqueue> =>
  Enqueue.fromSender(
    createSender({
      connectionString,
      ...(client === undefined ? {} : { client }),
    }),
  )
