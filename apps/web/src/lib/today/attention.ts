import { Effect, Schema } from 'effect'
import { isProviderId } from '@spaces/core/providers/registry'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import { JOB_PAGE, productOf } from '#/lib/connections/products'
import type { AccountJob } from '#/lib/connections/products'
import { reviewGroupsProgram } from '#/lib/inbox/review-groups'
import type { ReviewGroup } from '#/lib/inbox/review-groups'
import { movingProgram } from '#/lib/records/moving'
import type { MovingSignal } from '#/lib/records/moving'

/**
 * What Today reads beyond the existing lists: open Review cards grouped by
 * source and space, the reader's broken connections, and What's moving. (D79)
 * Outside `lib/server/` so tests can call the programs without a request.
 */

export type { MovingSignal, ReviewGroup }

export class ConnectionsReadFailed extends Schema.TaggedError<ConnectionsReadFailed>()(
  'ConnectionsReadFailed',
  { cause: Schema.Defect() },
) {}

/** One of the user's connections the provider stopped honouring. */
export type BrokenConnection = {
  connectionId: string
  /** `Gmail`, `Google Drive`. */
  label: string
  externalEmail: string
  errorReason: string | null
  /** The settings page it is listed on. */
  fixTo: (typeof JOB_PAGE)[AccountJob]
}

export type TodayAttention = {
  review: ReviewGroup[]
  moving: MovingSignal[]
  broken: BrokenConnection[]
}

/** The user's own connections in `error`, each with the page that fixes it. */
export const brokenConnectionsProgram = Effect.fn('brokenConnectionsProgram')(
  function* (
    userId: string,
  ): Effect.fn.Return<BrokenConnection[], ConnectionsReadFailed> {
    const rows = yield* Effect.tryPromise({
      try: () => listConnectionsFor(userId),
      catch: (cause) => new ConnectionsReadFailed({ cause }),
    })
    return rows.flatMap((r) => {
      if (r.status !== 'error' || !isProviderId(r.provider)) return []
      const product = productOf(r.provider, r.product)
      if (product === null) return []
      return [
        {
          connectionId: r.id,
          label: product.label,
          externalEmail: r.externalEmail,
          errorReason: r.errorReason,
          fixTo: JOB_PAGE[product.job],
        },
      ]
    })
  },
)

export const todayAttentionProgram = Effect.fn('todayAttentionProgram')(
  function* (userId: string, now: Date) {
    const [review, moving, broken] = yield* Effect.all(
      [
        reviewGroupsProgram(),
        movingProgram(userId, now),
        brokenConnectionsProgram(userId),
      ],
      { concurrency: 'unbounded' },
    )
    const out: TodayAttention = { review, moving, broken }
    return out
  },
)
