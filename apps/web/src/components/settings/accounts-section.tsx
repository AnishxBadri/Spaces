import {
  Link,
  useLocation,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { icon } from '#/components/icons'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import {
  SettingsGroupHead,
  SettingsSection,
  useSettingsPage,
} from './settings-section'
import { BoundFoldersSection } from './bound-folders-section'
import { MailSyncSettings } from './mail-sync-section'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { useConfirm } from '#/components/ui/confirm-dialog'
import { PROVIDERS } from '@spaces/core/providers/registry'
import type { ProviderId } from '@spaces/core/providers/registry'
import {
  accountOf,
  accountsFor,
  defaultMailAccount,
  offerFor,
  providersFor,
  syncStateOf,
  wordsOf,
} from '#/lib/connections/accounts'
import type { Account, Offer, SyncState } from '#/lib/connections/accounts'
import {
  JOB_PAGE,
  connectHref,
  productOf,
  productsOf,
} from '#/lib/connections/products'
import type { AccountJob } from '#/lib/connections/products'
import type {
  AccountBindings,
  AccountsView,
  ConnectionDisconnectResult,
  ConnectionListRow,
  MailboxSyncView,
} from '#/lib/server-fns'
import { disconnectConnection } from '#/lib/server-fns'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'
import { ProviderMark } from '#/components/provider-mark'
import type { Brand } from '#/components/provider-mark'

/**
 * Settings → You: the reader's accounts grouped by the job they do.
 * Underneath, a connection is one product row; these pages group the
 * rows by provider address, and an account page (`Options ›`) holds which
 * products it is used for and Disconnect.
 */

/** The jobs with an OAuth account page; meeting notes are keyed recorders (`MeetingNotesSection`). */
export type AccountPageJob = Exclude<AccountJob, 'meeting-notes'>

const TITLE = {
  'email-calendar': 'Email & calendar',
  files: 'Files',
} as const satisfies Record<AccountPageJob, string>

const LINK =
  'focus-ring rounded-md text-label text-graphite hover:text-foreground'

/** An account page's link: the list page's own drill-in, so its nav row stays lit. */
function OptionsLink({
  job,
  connectionId,
  label,
}: {
  job: AccountPageJob
  connectionId: string
  label: string
}) {
  return (
    <Link
      to={
        job === 'files'
          ? '/settings/files/$connectionId'
          : '/settings/email-calendar/$connectionId'
      }
      params={{ connectionId }}
      aria-label={label}
      className={LINK}
    >
      Options ›
    </Link>
  )
}

/** The list page: one row per account, then a Connect row per provider. */
export function AccountsSection({
  job,
  view,
  forwarding,
}: {
  job: AccountPageJob
  view: AccountsView
  /** Email & calendar's Bcc address: the workspace's forwarding mailbox, or null. */
  forwarding?: { address: string | null } | undefined
}) {
  const { isAdmin } = useSettingsPage()
  const accounts = accountsFor(job, view.connections)
  const fallback = job === 'email-calendar' ? 'gmail' : 'drive'
  const sender =
    job === 'email-calendar' ? defaultMailAccount(view.connections) : null
  return (
    <SettingsSection title={TITLE[job]} crumb="You">
      <div className="flex flex-col">
        <SettingsGroupHead title="Accounts" count={accounts.length} />
        {accounts.length === 0 ? (
          <p className="border-b border-rule px-3 py-3 text-label text-graphite">
            No accounts connected.
          </p>
        ) : (
          accounts.map((account) => (
            <AccountRow
              key={`${account.provider}:${account.email}`}
              job={job}
              account={account}
              mark={account.held.at(0)?.product ?? fallback}
              isDefault={
                sender !== null &&
                sender.provider === account.provider &&
                sender.email === account.email
              }
            />
          ))
        )}
        {providersFor(job).map(({ provider, products }) => (
          <ConnectRow
            key={provider}
            provider={provider}
            words={products
              .map((p) => productOf(provider, p)?.word ?? p)
              .join(' · ')}
            offer={offerFor(provider, products, view, isAdmin)}
            returnTo={JOB_PAGE[job]}
          />
        ))}
      </div>
      {forwarding !== undefined ? (
        <ForwardingAddress address={forwarding.address} />
      ) : null}
    </SettingsSection>
  )
}

/** The status lane's square. */
const STATUS_DOT: Record<SyncState['tone'], string> = {
  ok: 'bg-primary',
  error: 'bg-destructive',
  revoked: 'border border-graphite',
}

const STATUS_INK: Record<SyncState['tone'], string> = {
  ok: 'text-graphite',
  error: 'text-destructive',
  revoked: 'text-graphite',
}

function SyncLane({ state }: { state: SyncState }) {
  return (
    <span className="flex w-56 min-w-0 shrink-0 items-center gap-1.5">
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0', STATUS_DOT[state.tone])}
      />
      <span
        title={state.text}
        className={cn('truncate mono text-micro', STATUS_INK[state.tone])}
      >
        {state.text}
      </span>
    </span>
  )
}

function AccountRow({
  job,
  account,
  mark,
  isDefault,
}: {
  job: AccountPageJob
  account: Account
  mark: string
  isDefault: boolean
}) {
  const { today } = useClock()
  const first = account.held.at(0)
  return (
    <div className="flex min-h-12 items-center gap-3.5 border-b border-rule px-3 py-2">
      <ProductMark provider={account.provider} product={mark} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <span className="truncate text-body text-foreground">
          {account.email}
        </span>
        {isDefault ? (
          <span
            title="New email sends from this account"
            className="inline-flex h-5 shrink-0 items-center border border-rule bg-bone px-1.5 mono text-micro text-foreground"
          >
            Default
          </span>
        ) : null}
      </div>
      <span className="w-36 shrink-0 truncate mono text-micro text-foreground">
        {wordsOf(account.held)}
      </span>
      <SyncLane state={syncStateOf(account.held, today)} />
      <span className="flex w-20 shrink-0 justify-end">
        {first !== undefined ? (
          <OptionsLink
            job={job}
            connectionId={first.connectionId}
            label={`Options for ${account.email}`}
          />
        ) : null}
      </span>
    </div>
  )
}

/** One provider: its mark and the products it brings to this page, then what the reader can do. */
function ConnectRow({
  provider,
  words,
  offer,
  returnTo,
}: {
  provider: ProviderId
  words: string
  offer: Offer
  returnTo: string
}) {
  const label = PROVIDERS[provider].label
  return (
    <div className="flex min-h-12 items-center gap-3.5 border-b border-rule px-3 py-2">
      <ProductMark
        provider={provider}
        product={productsOf(provider).at(0)?.product ?? provider}
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <span className="shrink-0 text-body text-foreground">{label}</span>
        <span className="truncate mono text-micro text-graphite">{words}</span>
      </div>
      <OfferControl
        provider={provider}
        offer={offer}
        connect={(product) => connectHref(provider, product, [], returnTo)}
        connectLabel={`Connect ${label}`}
      />
    </div>
  )
}

/** Connect, or what stands in its way: Set up ›, Ask an admin, Not available yet. */
function OfferControl({
  provider,
  offer,
  connect,
  connectLabel,
}: {
  provider: ProviderId
  offer: Offer
  connect: (product: string) => string
  connectLabel: string
}) {
  switch (offer.kind) {
    case 'connect':
      return (
        <Button size="sm" asChild>
          <a href={connect(offer.product)}>{connectLabel}</a>
        </Button>
      )
    case 'configure':
      return (
        <Link
          to="/settings/connections/$provider"
          params={{ provider }}
          className={LINK}
        >
          Set up {PROVIDERS[provider].label} ›
        </Link>
      )
    case 'ask':
      return <span className="text-label text-graphite">Ask an admin</span>
    case 'unavailable':
      return <span className="text-label text-graphite">Not available yet</span>
  }
}

/** The workspace's Bcc address, read-only, with Copy; the mailbox itself is Email forwarding's. */
function ForwardingAddress({ address }: { address: string | null }) {
  const copy = (value: string) => {
    navigator.clipboard.writeText(value).then(
      () => toast.success('Address copied'),
      () => toast.error('Could not copy — select it above'),
    )
  }
  return (
    <div className="flex flex-col">
      <SettingsGroupHead
        title="Bcc address"
        action={
          <Link to="/settings/email-forwarding" className={LINK}>
            Email forwarding ›
          </Link>
        }
      />
      {address === null ? (
        <p className="border-b border-rule px-3 py-3 text-label text-graphite">
          No forwarding address.
        </p>
      ) : (
        <div className="flex min-h-12 items-center gap-3 border-b border-rule px-3 py-2">
          <code className="min-w-0 flex-1 truncate mono text-label text-foreground">
            {address}
          </code>
          <Button
            size="xs"
            variant="outline"
            onClick={() => copy(address)}
            aria-label={`Copy ${address}`}
          >
            <icon.copy className="size-3" strokeWidth={2} />
            Copy
          </Button>
        </div>
      )}
    </div>
  )
}

/** The toast a product's Disconnect earns, naming what the provider was told. */
function disconnectedLine(
  word: string,
  account: Account,
  result: ConnectionDisconnectResult['revoke'],
): string {
  const provider = PROVIDERS[account.provider].label
  switch (result) {
    case 'kept':
      return `${word} disconnected · ${account.email} stays connected for the rest`
    case 'none':
      return `${word} disconnected`
    case 'unreachable':
      return `${word} disconnected; ${provider} could not be reached to revoke access`
    case 'revoked':
    case 'already-revoked':
      return `${word} disconnected · ${provider} access revoked`
  }
}

/** What a Disconnect does to the folders bound through it, when it has any. */
function pausesLine(count: number): string | null {
  if (count === 0) return null
  return `${String(count)} bound ${count === 1 ? 'folder pauses' : 'folders pause'} until someone re-binds ${count === 1 ? 'it' : 'them'} with their own connection. Nothing already copied is deleted.`
}

/**
 * The account page (`Options ›`): which products the account is used for —
 * ticking one runs that product's own consent, unticking disconnects it —
 * each product's last sync, and Disconnect for this page's products.
 * - A product's per-connection choices are drawn only when its plugin runs
 *   on the account: a mail sync's sharing and exclude list.
 * - Sync now is drawn only for a product with a per-connection sync job.
 * - A storage account lists its bound folders; Disconnect then warns how
 *   many pause.
 */
export function AccountSection({
  job,
  connectionId,
  view,
  mail,
  bindings,
}: {
  job: AccountPageJob
  connectionId: string
  view: AccountsView
  /** The account's mail sync and its settings; absent or null when none runs. */
  mail?: { connectionId: string; view: MailboxSyncView } | null
  /** A storage account's binding health; absent or null on other pages. */
  bindings?: AccountBindings | null
}) {
  const { isAdmin } = useSettingsPage()
  const { today } = useClock()
  const router = useRouter()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { confirm, confirmDialog } = useConfirm()
  const [pending, setPending] = useState(false)

  const row = view.connections.find((r) => r.connectionId === connectionId)
  if (row === undefined)
    return (
      <SettingsSection title={TITLE[job]} crumb="You">
        <p className="border-b border-rule px-3 py-3 text-label text-graphite">
          No such account.
        </p>
      </SettingsSection>
    )
  const account = accountOf(row, job, view.connections)
  const provider = PROVIDERS[account.provider].label
  // Folders bound through these connections: what their Disconnect pauses.
  const boundOn = (ids: ReadonlyArray<string>) =>
    (bindings?.bindings ?? []).filter(
      (b) => b.connectionId !== null && ids.includes(b.connectionId),
    ).length

  /** After a disconnect: stay on a row of this account still on this page, else go back to the list. */
  async function landAfter(gone: ReadonlyArray<string>) {
    const left = account.held.find((r) => !gone.includes(r.connectionId))
    if (left === undefined) {
      await navigate({ to: JOB_PAGE[job], replace: true })
      return
    }
    if (gone.includes(connectionId))
      await navigate({
        to:
          job === 'files'
            ? '/settings/files/$connectionId'
            : '/settings/email-calendar/$connectionId',
        params: { connectionId: left.connectionId },
        replace: true,
      })
    await router.invalidate()
  }

  async function untick(held: ConnectionListRow) {
    const word = productOf(held.provider, held.product)?.word ?? held.product
    const others = account.rows.filter(
      (r) => r.connectionId !== held.connectionId && r.status !== 'revoked',
    )
    const ok = await confirm({
      title: `Stop using ${account.email} for ${word}?`,
      body:
        pausesLine(boundOn([held.connectionId])) ??
        (others.length > 0
          ? `Spaces deletes its ${word} connection. ${wordsOf(others)} stay connected, so ${provider} keeps the access they use.`
          : `Spaces revokes its access at ${provider} and forgets ${account.email}. Files already copied stay.`),
      action: 'Disconnect',
    })
    if (!ok) return
    setPending(true)
    try {
      const result = await disconnectConnection({
        data: { connectionId: held.connectionId },
      })
      toast(disconnectedLine(word, account, result.revoke))
      await landAfter([held.connectionId])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect')
    } finally {
      setPending(false)
    }
  }

  async function disconnectAll() {
    const words = wordsOf(account.held)
    const others = account.rows.filter(
      (r) => !account.held.includes(r) && r.status !== 'revoked',
    )
    const ok = await confirm({
      title: `Disconnect ${account.email} from ${TITLE[job]}?`,
      body:
        pausesLine(boundOn(account.held.map((r) => r.connectionId))) ??
        (others.length > 0
          ? `Spaces stops using it for ${words}. ${wordsOf(others)} stay connected.`
          : `Spaces stops using it for ${words}, revokes its access at ${provider} and forgets the account. Files already copied stay.`),
      action: 'Disconnect',
    })
    if (!ok) return
    setPending(true)
    const gone: Array<string> = []
    try {
      let last: ConnectionDisconnectResult['revoke'] = 'kept'
      for (const held of account.held) {
        const result = await disconnectConnection({
          data: { connectionId: held.connectionId },
        })
        gone.push(held.connectionId)
        last = result.revoke
      }
      toast(disconnectedLine(words, account, last))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect')
    } finally {
      setPending(false)
      await landAfter(gone)
    }
  }

  return (
    <SettingsSection
      title={account.email}
      crumb="You"
      action={
        <Button
          variant="outline"
          disabled={pending || account.held.length === 0}
          onClick={() => void disconnectAll()}
        >
          Disconnect
        </Button>
      }
    >
      <p className="px-3 pt-3 mono text-micro text-graphite">
        {provider} · {syncStateOf(account.held, today).text}
      </p>
      <div className="flex flex-col">
        <SettingsGroupHead title="Used for" />
        {productsOf(account.provider).map(({ product, entry }) => {
          const held = account.rows.find((r) => r.product === product)
          return (
            <ProductRow
              key={product}
              provider={account.provider}
              product={product}
              word={entry.word}
              held={held}
              offer={offerFor(account.provider, [product], view, isAdmin)}
              disabled={pending}
              connect={connectHref(
                account.provider,
                product,
                [],
                pathname,
                account.email,
              )}
              onUntick={(r) => void untick(r)}
            />
          )
        })}
      </div>
      {mail ? (
        <MailSyncSettings connectionId={mail.connectionId} view={mail.view} />
      ) : null}
      {bindings ? <BoundFoldersSection view={bindings} /> : null}
      {confirmDialog}
    </SettingsSection>
  )
}

/**
 * One product on the account page: its tick, then its sync state when held
 * — Reconnect when it failed — or what stands in the way of ticking it.
 */
function ProductRow({
  provider,
  product,
  word,
  held,
  offer,
  disabled,
  connect,
  onUntick,
}: {
  provider: ProviderId
  product: string
  word: string
  held: ConnectionListRow | undefined
  offer: Offer
  disabled: boolean
  /** The start route this product's own consent leaves through. */
  connect: string
  onUntick: (row: ConnectionListRow) => void
}) {
  const { today } = useClock()
  const canTick = held !== undefined || offer.kind === 'connect'
  let lane: ReactNode
  if (held !== undefined) {
    const state = syncStateOf([held], today)
    lane = (
      <>
        <SyncLane state={state} />
        <span className="flex w-24 shrink-0 justify-end">
          {state.tone !== 'ok' && offer.kind === 'connect' ? (
            <Button size="xs" variant="outline" asChild>
              <a href={connect} aria-label={`Reconnect ${word}`}>
                Reconnect
              </a>
            </Button>
          ) : null}
        </span>
      </>
    )
  } else if (offer.kind === 'connect') {
    lane = null
  } else {
    lane = (
      <span className="flex shrink-0 justify-end">
        <OfferControl
          provider={provider}
          offer={offer}
          connect={() => connect}
          connectLabel={`Connect ${word}`}
        />
      </span>
    )
  }
  return (
    <label
      className={cn(
        'flex min-h-12 items-center gap-3.5 border-b border-rule px-3 py-2',
        canTick && !disabled && 'cursor-pointer',
      )}
    >
      <Checkbox
        checked={held !== undefined}
        disabled={disabled || !canTick}
        aria-label={word}
        onCheckedChange={(next) => {
          if (next && held === undefined) window.location.assign(connect)
          if (!next && held !== undefined) onUntick(held)
        }}
      />
      <ProductMark provider={provider} product={product} />
      <span className="min-w-0 flex-1 truncate text-body text-foreground">
        {word}
      </span>
      {lane}
    </label>
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
      <ProviderMark
        brand={
          provider === 'box' ? 'box' : (PRODUCT_BRAND[product] ?? 'google')
        }
      />
    </span>
  )
}

/** Each Google product's own mark. */
const PRODUCT_BRAND: Partial<Record<string, Brand>> = {
  drive: 'googleDrive',
  gmail: 'gmail',
  calendar: 'googleCalendar',
}
