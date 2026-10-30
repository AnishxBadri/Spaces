import { Clock, Effect, Schema } from 'effect'
import { PROVIDERS, isProviderId } from '@spaces/core/providers/registry'
import type { ProviderId } from '@spaces/core/providers/registry'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import type { ConnectionListing } from '@spaces/core/writes/connections/list'
import { parkedEnrichmentProgram } from '@spaces/core/writes/enrichment/parked'
import type { ParkedSource } from '@spaces/core/writes/enrichment/parked'
import { waitingExportsProgram } from '@spaces/core/writes/bindings/export'
import {
  JOB_PAGE,
  PRODUCTS,
  connectHref,
  productOf,
  productsOf,
} from '#/lib/connections/products'
import { getConfiguredProvidersProgram } from '#/lib/connections/provider-apps'
import { bundledUseRows } from '#/lib/connections/providers'
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
 * broken connections, the invitation to connect Google and the grants about
 * to lapse, auto-enrich runs parked at a source's cap, folder bindings that
 * cannot sync, and What's moving.
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
  /** Whose page fixes it: the provider's, under Settings → Connections. */
  provider: ProviderId
}

/** Google is set up and the reader has connected nothing to it yet. */
export type ConnectInvite = {
  provider: ProviderId
  /** `Google`. */
  label: string
  /** The connect dance for the first use that is on, back to Today. */
  href: string
}

/** A grant the provider will drop soon: personal Gmail lapses every 7 days. */
export type ExpiringConnection = {
  connectionId: string
  /** `Google`. */
  label: string
  /** Whole days left, at least 1. */
  days: number
  /** The same account's dance again, back to Today. */
  href: string
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
  invite: ConnectInvite | null
  expiring: ExpiringConnection[]
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
          provider: r.provider,
        },
      ]
    })
  },
)

const DAY_MS = 24 * 3_600_000

/** How close a lapse must be before Today says so. */
const EXPIRY_NOTICE_MS = 2 * DAY_MS

/**
 * The reader's grants that lapse within 48h, one line per account, its
 * soonest product's dance as the fix. Google gives a lapse time only to a
 * client in Testing, so only personal Gmail ever reads here.
 */
export function expiringOf(
  rows: ReadonlyArray<ConnectionListing>,
  nowMs: number,
): ExpiringConnection[] {
  const soon = rows
    .flatMap((r) => {
      const at = r.refreshTokenExpiresAt?.getTime()
      if (
        r.status !== 'active' ||
        at === undefined ||
        !isProviderId(r.provider)
      )
        return []
      const left = at - nowMs
      return left > 0 && left <= EXPIRY_NOTICE_MS
        ? [{ row: r, provider: r.provider, left }]
        : []
    })
    .sort((a, b) => a.left - b.left)
  const out: ExpiringConnection[] = []
  const seen = new Set<string>()
  for (const { row, provider, left } of soon) {
    const account = `${provider}:${row.externalEmail}`
    if (seen.has(account)) continue
    seen.add(account)
    out.push({
      connectionId: row.id,
      label: PROVIDERS[provider].label,
      days: Math.max(1, Math.ceil(left / DAY_MS)),
      href: connectHref(provider, row.product, [], '/today', row.externalEmail),
    })
  }
  return out
}

/**
 * The invitation to bring mail and meetings in: Google has a client, one of
 * its uses is on, and the reader holds no live Google connection.
 */
export function inviteOf(
  rows: ReadonlyArray<ConnectionListing>,
  configured: ReadonlyArray<ProviderId>,
  enabledPlugins: ReadonlyArray<string>,
): ConnectInvite | null {
  const provider: ProviderId = 'google'
  if (!configured.includes(provider)) return null
  if (rows.some((r) => r.provider === provider && r.status !== 'revoked'))
    return null
  const first = productsOf(provider).find((p) =>
    enabledPlugins.includes(p.entry.plugin),
  )
  if (first === undefined) return null
  return {
    provider,
    label: PROVIDERS[provider].label,
    href: connectHref(provider, first.product, [], '/today'),
  }
}

/** The connection lines that are offers and warnings rather than breakages. */
export const connectionNoticesProgram = Effect.fn('connectionNoticesProgram')(
  function* (userId: string) {
    const rows = yield* Effect.tryPromise({
      try: () => listConnectionsFor(userId),
      catch: (cause) => new ConnectionsReadFailed({ cause }),
    })
    const configured = yield* getConfiguredProvidersProgram()
    const uses = yield* Effect.tryPromise({
      try: () => bundledUseRows(),
      catch: (cause) => new ConnectionsReadFailed({ cause }),
    })
    const now = yield* Clock.currentTimeMillis
    return {
      invite: inviteOf(
        rows,
        configured,
        uses.filter((u) => u.enabled).map((u) => u.capabilityId),
      ),
      expiring: expiringOf(rows, now),
    }
  },
)

const reviewProgram = Effect.fn('todayReview')(function* (viewer: string) {
  const review = yield* listInboxProgram({ record: null, viewer })
  const filedIn = yield* filedInProgram(review)
  return { review, filedIn }
})

export const todayAttentionProgram = Effect.fn('todayAttentionProgram')(
  function* (userId: string, now: Date) {
    const [
      { review, filedIn },
      moving,
      broken,
      { invite, expiring },
      parked,
      waiting,
      failing,
    ] = yield* Effect.all(
      [
        reviewProgram(userId),
        movingProgram(userId, now),
        brokenConnectionsProgram(userId),
        connectionNoticesProgram(userId),
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
      invite,
      expiring,
      parked,
      waiting,
      failing,
    }
    return out
  },
)
