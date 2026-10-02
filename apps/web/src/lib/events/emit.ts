import { Effect } from 'effect'
import { dispatchDomainEvent } from '@spaces/core/writes/events/dispatch'
import type { DomainEvent } from '@spaces/sdk'
import { webEnqueue } from '#/lib/enqueue-live'

/**
 * A committed birth's `entity.created`, dispatched from a web or worker
 * caller that is not itself an Effect program. Call it only after the
 * birth's transaction has committed. Never rejects. (D65)
 */
export function emitDomainEvent(event: DomainEvent | null): Promise<void> {
  if (event === null) return Promise.resolve()
  return Effect.runPromise(
    dispatchDomainEvent(event).pipe(Effect.provide(webEnqueue), Effect.asVoid),
  )
}
