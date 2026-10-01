import { Context, Effect, Layer } from 'effect'
import type { EnqueueOptions, Sender } from './sender'
import type { QueueName } from './names'

/**
 * The queue seam as an Effect service (sdk-7a, decided at publish): a
 * write port that hands work back — `resolveEntity`'s `reembed`, sdk-8a's
 * extraction — enqueues through this, and whoever runs the port provides
 * it. The worker builds it from `createSender` with its own `DATABASE_URL`
 * (`Enqueue.fromSender`), so a port running there never reaches web's
 * `#web/lib/queue`; a test provides a recording one. Pure: core reads no
 * environment, and this declares only the shape.
 *
 * Never fails, like every enqueue (`Sender.enqueue`): a job that could not
 * be sent answers `null`, and the write it follows stays committed.
 */
export class Enqueue extends Context.Service<
  Enqueue,
  {
    readonly enqueue: (
      queue: QueueName,
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
