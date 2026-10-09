import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { SettingsSection } from './settings-section'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { PROVIDERS, PROVIDER_IDS } from '@spaces/core/providers/registry'
import type { ProviderId, ProviderScope } from '@spaces/core/providers/registry'
import {
  CONNECT_PRODUCT,
  PRODUCTS,
  connectHref,
  productOf,
  productScopes,
} from '#/lib/connections/products'
import type { ConnectionListRow } from '#/lib/server-fns'
import { disconnectConnection, refreshConnection } from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import { oauthClientAnchor } from './connection-apps-section'

/**
 * Settings → Connections. A band per provider, then the reader's own
 * connections under it — one row per (product, account) — and Connect for
 * a product they hold none of. A provider without an OAuth client says so in
 * its band; an admin's band links to its client under Connection apps.
 */
export function ConnectionsSection({
  isAdmin,
  configured,
  connections,
}: {
  /** An admin configures a missing client; a member is told to ask one. */
  isAdmin: boolean
  /** Providers with an active OAuth client; the rest draw nothing to click. */
  configured: ReadonlyArray<ProviderId>
  /** The reader's own connections, never another member's. */
  connections: ReadonlyArray<ConnectionListRow>
}) {
  const { confirm, confirmDialog } = useConfirm()
  return (
    <SettingsSection title="Connections" crumb="You">
      {PROVIDER_IDS.map((provider) => (
        <ProviderGroup
          key={provider}
          provider={provider}
          configured={configured.includes(provider)}
          admin={isAdmin}
          rows={connections.filter((c) => c.provider === provider)}
          confirm={confirm}
        />
      ))}
      {confirmDialog}
    </SettingsSection>
  )
}

type Confirm = ReturnType<typeof useConfirm>['confirm']

/**
 * One provider: its band, then per product the reader's rows, or Connect
 * when they hold none and the provider has a client. Connect leaves for the
 * provider's consent screen through the start route — a full navigation.
 */
function ProviderGroup({
  provider,
  configured,
  admin,
  rows,
  confirm,
}: {
  provider: ProviderId
  configured: boolean
  admin: boolean
  rows: ReadonlyArray<ConnectionListRow>
  confirm: Confirm
}) {
  const label = PROVIDERS[provider].label
  const products = productsToDraw(provider, rows)
  return (
    <div className="flex flex-col pt-8">
      <SectionHead
        as="h3"
        title={label}
        action={
          configured ? null : admin ? (
            <a
              href={`/settings/connection-apps#${oauthClientAnchor(provider)}`}
              className="focus-ring rounded-md text-foreground underline-offset-4 hover:underline"
            >
              Configure {label}
            </a>
          ) : (
            <span>Ask an admin to configure {label}</span>
          )
        }
      />
      {products.map((product) => {
        const held = rows.filter((r) => r.product === product)
        if (held.length > 0)
          return held.map((row) => (
            <ConnectionRow
              key={row.connectionId}
              row={row}
              configured={configured}
              confirm={confirm}
            />
          ))
        return configured ? (
          <ConnectRow key={product} provider={provider} product={product} />
        ) : null
      })}
    </div>
  )
}

/** The settings Connect product, then every product the reader holds, in registry order. */
function productsToDraw(
  provider: ProviderId,
  rows: ReadonlyArray<ConnectionListRow>,
): string[] {
  const held = new Set(rows.map((r) => r.product))
  const known = Object.keys(PRODUCTS[provider])
  const drawn = known.filter(
    (p) => p === CONNECT_PRODUCT[provider] || held.has(p),
  )
  return [...drawn, ...[...held].filter((p) => !known.includes(p))]
}

function ConnectRow({
  provider,
  product,
}: {
  provider: ProviderId
  product: string
}) {
  const entry = productOf(provider, product)
  if (entry === null) return null
  return (
    <div className="flex min-h-14 items-center gap-3.5 border-b border-rule px-3 py-2">
      <ProductMark provider={provider} product={product} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body text-foreground">{entry.name}</span>
        <span className="truncate mono text-micro text-graphite">
          {productScopes(provider, product).join(' · ')}
        </span>
      </div>
      <Button size="sm" asChild>
        <a
          href={connectHref(provider, product)}
          aria-label={`Connect ${entry.label}`}
        >
          Connect
        </a>
      </Button>
    </div>
  )
}

/** The status lane's square and word. */
const STATUS_DOT: Record<ConnectionListRow['status'], string> = {
  active: 'bg-primary',
  error: 'bg-destructive',
  revoked: 'border border-graphite',
}

const STATUS_INK: Record<ConnectionListRow['status'], string> = {
  active: 'text-foreground',
  error: 'text-destructive',
  revoked: 'text-graphite',
}

/** The product's own scopes the row holds; sign-in scopes every row shares are left out. */
export function grantedScopes(row: ConnectionListRow): ProviderScope[] {
  const vocabulary: ReadonlyArray<ProviderScope> =
    PROVIDERS[row.provider].scopes
  return vocabulary.filter(
    (s) => s.plugin !== null && row.scopes.includes(s.value),
  )
}

/** `synced 09-29`, or `never synced` while nothing has written `last_sync_at`. */
export function lastSyncOf(row: ConnectionListRow): string {
  return row.lastSyncAt === null
    ? 'never synced'
    : `synced ${row.lastSyncAt.slice(5, 10)}`
}

/**
 * One connection: mark, product and account, its scopes as chips with the
 * provider's reason inline when it is in error, last sync, status, then
 * Refresh (active) or Reconnect (error, revoked) and Disconnect.
 */
function ConnectionRow({
  row,
  configured,
  confirm,
}: {
  row: ConnectionListRow
  configured: boolean
  confirm: Confirm
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const entry = productOf(row.provider, row.product)
  const providerLabel = PROVIDERS[row.provider].label
  const name = entry?.name ?? row.product
  const label = entry?.label ?? `${providerLabel} ${row.product}`
  const scopes = grantedScopes(row)
  const reason = row.errorReason ?? 'the provider gave no reason'

  async function refresh() {
    setPending(true)
    try {
      await refreshConnection({ data: { connectionId: row.connectionId } })
      toast(`${label} refreshed`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not refresh')
    } finally {
      setPending(false)
      await router.invalidate()
    }
  }

  async function disconnect() {
    const ok = await confirm({
      title: `Disconnect ${label}?`,
      body: `Spaces revokes its access at ${providerLabel} and forgets ${row.externalEmail}. Files already copied stay.`,
      action: 'Disconnect',
    })
    if (!ok) return
    setPending(true)
    try {
      const result = await disconnectConnection({
        data: { connectionId: row.connectionId },
      })
      toast(
        result.revoke === 'unreachable'
          ? `${label} disconnected; ${providerLabel} could not be reached to revoke access`
          : `${label} disconnected`,
      )
      await router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect')
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-14 items-center gap-3.5 border-b border-rule px-3 py-2">
      <ProductMark provider={row.provider} product={row.product} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <span className="shrink-0 text-body text-foreground">{name}</span>
          <span className="truncate mono text-micro text-graphite">
            {row.externalEmail}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {scopes.map((scope) => (
            <span
              key={scope.value}
              title={scope.label}
              className="inline-flex h-5 shrink-0 items-center border border-rule bg-bone px-1.5 mono text-micro text-foreground"
            >
              {scope.value}
            </span>
          ))}
          {row.status === 'error' ? (
            <span
              title={reason}
              className="ml-1 truncate mono text-micro text-destructive"
            >
              {reason}
            </span>
          ) : null}
        </div>
      </div>
      <span className="w-24 shrink-0 mono text-micro text-graphite">
        {lastSyncOf(row)}
      </span>
      <span className="flex w-20 shrink-0 items-center gap-1.5">
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0', STATUS_DOT[row.status])}
        />
        <span className={cn('mono text-micro', STATUS_INK[row.status])}>
          {row.status}
        </span>
      </span>
      <div className="flex w-48 shrink-0 justify-end gap-1">
        {row.status === 'active' ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void refresh()}
            aria-label={`Refresh ${label} ${row.externalEmail}`}
          >
            Refresh
          </Button>
        ) : configured && entry !== null ? (
          <Button size="sm" variant="outline" asChild>
            <a
              href={connectHref(row.provider, row.product)}
              aria-label={`Reconnect ${label} ${row.externalEmail}`}
            >
              Reconnect
            </a>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={row.status === 'active' ? 'outline' : 'ghost'}
          disabled={pending}
          onClick={() => void disconnect()}
          aria-label={`Disconnect ${label} ${row.externalEmail}`}
        >
          Disconnect
        </Button>
      </div>
    </div>
  )
}

/** The product's own mark at 16px in a 28px hairline frame. */
function ProductMark({
  provider,
  product,
}: {
  provider: ProviderId
  product: string
}) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center border border-hairline bg-paper">
      <svg aria-hidden viewBox="0 0 24 24" className="size-4">
        {MARKS[provider === 'box' ? 'box' : product]}
      </svg>
    </span>
  )
}

/** Provider marks in their own colours, drawn on a 24-unit square. */
const MARKS: Record<string, ReactNode> = {
  drive: (
    <g transform="scale(0.2749) translate(0 4.3)">
      <path
        d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
        fill="#0066da"
      />
      <path
        d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"
        fill="#00ac47"
      />
      <path
        d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
        fill="#ea4335"
      />
      <path
        d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
        fill="#00832d"
      />
      <path
        d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
        fill="#2684fc"
      />
      <path
        d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
        fill="#ffba00"
      />
    </g>
  ),
  gmail: (
    <g transform="translate(0 1)">
      <path
        fill="#4285f4"
        d="M1.6 21h3.8v-9.2L0 7.75V19.4c0 .9.7 1.6 1.6 1.6z"
      />
      <path
        fill="#34a853"
        d="M18.6 21h3.8c.9 0 1.6-.7 1.6-1.6V7.75l-5.4 4.05z"
      />
      <path fill="#fbbc04" d="M18.6 4.8v7l5.4-4.05V5.6c0-2-2.3-3.1-3.8-1.9z" />
      <path fill="#ea4335" d="M5.4 11.8v-7L12 9.75l6.6-4.95v7L12 16.75z" />
      <path
        fill="#c5221f"
        d="M0 5.6v2.15l5.4 4.05v-7L3.8 3.7C2.3 2.5 0 3.6 0 5.6z"
      />
    </g>
  ),
  calendar: (
    <g>
      <path d="M3 3h18v5H3z" fill="#4285f4" />
      <path d="M3 8h3v13H3z" fill="#34a853" />
      <path d="M18 8h3v9h-3z" fill="#fbbc04" />
      <path d="M18 17h3v4h-3z" fill="#ea4335" />
      <path d="M6 18h12v3H6z" fill="#188038" />
      <path d="M9 11h6v1.5H9zM9 14h6v1.5H9z" fill="#4285f4" />
    </g>
  ),
  box: (
    <g fill="none" stroke="#0061d5" strokeWidth="1.8" strokeLinecap="round">
      <path d="M2.9 6v7.5" />
      <circle cx="5.9" cy="13.5" r="3" />
      <circle cx="13.2" cy="13.5" r="3" />
      <path d="m17.8 10.3 4.6 6.4m0-6.4-4.6 6.4" />
    </g>
  ),
}
