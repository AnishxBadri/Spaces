import { Effect, Schema } from 'effect'
import { isProviderId } from '@spaces/core/providers/registry'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import { parkedEnrichmentProgram } from '@spaces/core/writes/enrichment/parked'
import type { ParkedSource } from '@spaces/core/writes/enrichment/parked'
import { waitingExportsProgram } from '@spaces/core/writes/bindings/export'
import { JOB_PAGE, PRODUCTS, productOf } from '#/lib/connections/products'
import type { AccountJob } from '#/lib/connections/products'
import { reviewGroupsProgram } from '#/lib/inbox/review-groups'
import type { ReviewGroup } from '#/lib/inbox/review-groups'
import { movingProgram } from '#/lib/records/moving'
import type { MovingSignal } from '#/lib/records/moving'

/**
 * What Today reads beyond the existing lists: open Review cards grouped by
 * source and space, the reader's broken connections, auto-enrich runs parked
 * at a source's cap, and What's moving. (D76, D79)
 * Outside `lib/server/` so tests can call the programs without a request.
 */

export type { MovingSignal, ParkedSource, ReviewGroup }

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

/** Uploads on a pushing binding not yet in the provider's folder. (§6) */
export type WaitingExport = {
  provider: string
  /** `Drive`, `Box`. */
  label: string
  count: number
  fixTo: (typeof JOB_PAGE)['files']
}

export type TodayAttention = {
  review: ReviewGroup[]
  moving: MovingSignal[]
  broken: BrokenConnection[]
  parked: ParkedSource[]
  waiting: WaitingExport[]
}

/** The files product's short name under a provider: `Drive` under Google. */
const filesLabelOf = (provider: string): string => {
  if (!isProviderId(provider)) return provider
  const files = Object.values<{ name: string; job: string }>(
    PRODUCTS[provider],
  ).find((p) => p.job === 'files')
  return files?.name ?? provider
}

/** The export backlog by provider: what Today counts as waiting for a connection. */
export const waitingExportsForToday = Effect.fn('waitingExportsForToday')(
  function* () {
    const rows = yield* waitingExportsProgram()
    return rows.map((r): WaitingExport => ({
      provider: r.provider,
      label: filesLabelOf(r.provider),
      count: r.count,
      fixTo: JOB_PAGE.files,
    }))
  },
)

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
    const [review, moving, broken, parked, waiting] = yield* Effect.all(
      [
        reviewGroupsProgram(),
        movingProgram(userId, now),
        brokenConnectionsProgram(userId),
        parkedEnrichmentProgram(),
        waitingExportsForToday(),
      ],
      { concurrency: 'unbounded' },
    )
    const out: TodayAttention = { review, moving, broken, parked, waiting }
    return out
  },
)
