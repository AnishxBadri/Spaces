import { Effect, Schema } from 'effect'
import { isProviderId } from '@spaces/core/providers/registry'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import { parkedEnrichmentProgram } from '@spaces/core/writes/enrichment/parked'
import type { ParkedSource } from '@spaces/core/writes/enrichment/parked'
import { waitingExportsProgram } from '@spaces/core/writes/bindings/export'
import { JOB_PAGE, PRODUCTS, productOf } from '#/lib/connections/products'
import type { AccountJob } from '#/lib/connections/products'
import { filedInProgram } from '#/lib/inbox/filed-in'
import { listInboxProgram } from '#/lib/inbox/queue'
import type { InboxRow } from '#/lib/inbox/queue'
import { movingProgram } from '#/lib/records/moving'
import { failingBindingsForProgram } from '#/lib/documents/binding-health'
import type { FailingBinding } from '#/lib/documents/binding-health'
import type { MovingSignal } from '#/lib/records/moving'

/**
 * What Today reads beyond the existing lists: the open Review queue (flattened
 * into rows on the client, after the held decisions leave it), the reader's
 * broken connections, auto-enrich runs parked at a source's cap, folder
 * bindings that cannot sync, and What's moving.
 * Outside the server-fn barrel so tests can call the programs without a request.
 */

export type { FailingBinding, MovingSignal, ParkedSource }

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

/** Uploads on a pushing binding not yet in the provider's folder. */
export type WaitingExport = {
  provider: string
  /** `Drive`, `Box`. */
  label: string
  count: number
  fixTo: (typeof JOB_PAGE)['files']
}

export type TodayAttention = {
  /** The whole queue, the reader's Ask threads gathered under each thread. */
  review: InboxRow[]
  /** A file-here card's record by id: the path of the space it is filed in now. */
  filedIn: Record<string, string>
  moving: MovingSignal[]
  broken: BrokenConnection[]
  parked: ParkedSource[]
  waiting: WaitingExport[]
  failing: ReadonlyArray<FailingBinding>
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

const reviewProgram = Effect.fn('todayReview')(function* (viewer: string) {
  const review = yield* listInboxProgram({ record: null, viewer })
  const filedIn = yield* filedInProgram(review)
  return { review, filedIn }
})

export const todayAttentionProgram = Effect.fn('todayAttentionProgram')(
  function* (userId: string, now: Date) {
    const [{ review, filedIn }, moving, broken, parked, waiting, failing] =
      yield* Effect.all(
        [
          reviewProgram(userId),
          movingProgram(userId, now),
          brokenConnectionsProgram(userId),
          parkedEnrichmentProgram(),
          waitingExportsForToday(),
          failingBindingsForProgram(userId),
        ],
        { concurrency: 'unbounded' },
      )
    const out: TodayAttention = {
      review,
      filedIn,
      moving,
      broken,
      parked,
      waiting,
      failing,
    }
    return out
  },
)
