import { Context, Effect, Layer } from 'effect'
import type { EnqueueOptions, Sender } from './sender'
import type { EnqueueTarget } from './names'

/**
 * The queue seam as an Effect service: a write port that hands work back
 * (`resolveEntity`'s `reembed`, document extraction) enqueues through this,
 * and whoever runs the port provides it — the worker via
 * `Enqueue.fromSender`, a test with a recording one. Core reads no
 * environment, so this declares only the shape.
 *
 * Never fails, like every enqueue (`Sender.enqueue`): a job that could not
 * be sent answers `null`, and the write it follows stays committed.
 */
export class Enqueue extends Context.Service<
  Enqueue,
  {
    readonly enqueue: (
      queue: EnqueueTarget,
      data: Record<string, unknown>,
      options?: EnqueueOptions,
    ) => Effect.Effect<string | null>
  }
>()('spaces/core/Enqueue') {
  /** The Live a process builds from its own sender. */
  static fromSender(sender: Pick<Sender, 'enqueue'>): Layer.Layer<Enqueue> {
    return Layer.succeed(
      Enqueue,
      Enqueue.of({
        enqueue: (queue, data, options) =>
          Effect.promise(() => sender.enqueue(queue, data, options)),
      }),
    )
  }
}
