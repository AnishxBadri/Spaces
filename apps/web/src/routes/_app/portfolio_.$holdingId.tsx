import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { LedgerRow, LedgerSection } from '#/components/ledger-section'
import { useConfirm } from '#/components/ui/confirm-dialog'
import {
  DitherMark,
  RailEmpty,
  RailRow,
  RailSection,
  RecordBody,
  RecordHeader,
} from '#/components/record/record-parts'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  addDistribution,
  addInvestment,
  addMark,
  addRound,
  getHolding,
  voidLedgerEvent,
} from '#/lib/server-fns'
import { cn } from '#/lib/utils'
import {
  fmtMoney,
  fmtMultiple,
  fmtPct,
  fmtXirr,
} from '@spaces/core/portfolio/format'

export const Route = createFileRoute('/_app/portfolio_/$holdingId')({
  loader: async ({ params }) => getHolding({ data: { id: params.holdingId } }),
  component: HoldingPage,
})

type Holding = Awaited<ReturnType<typeof getHolding>>

function HoldingPage() {
  const h = Route.useLoaderData()
  const m = h.metrics.ok ? h.metrics.metrics : null

  const missing =
    h.metrics.ok === false
      ? [...new Set(h.metrics.missingRates.map((r) => r.currency))]
      : []

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        crumb={
          <>
            <Link to="/portfolio" className="focus-ring hover:text-foreground">
              Portfolio
            </Link>
            {' / '}
            {h.id.slice(0, 8)}
            {' / holding since '}
            {h.openedAt.slice(0, 10)}
            {m?.writtenOff ? ' · written off' : ''}
          </>
        }
        actions={
          <Button variant="outline" asChild>
            <Link
              to="/companies/$companyId"
              params={{ companyId: h.companyId }}
            >
              Company record ›
            </Link>
          </Button>
        }
        mark={<DitherMark />}
        name={h.companyName}
        badges={
          missing.length > 0 ? (
            // Amber is named, not resolved: `optionColor` returns a stored
            // colour unchanged, so a badge the instrument colours for itself
            // goes through the same primitive as the data-coloured ones.
            <Badge option={{ color: 'amber' }} index={0} className="shrink-0">
              unpriced · {missing.join(', ')}
            </Badge>
          ) : null
        }
        readouts={
          m
            ? [
                { label: 'Invested', value: fmtMoney(m.costBasis, m.currency) },
                {
                  label: m.lastMarkDate
                    ? `Value · marked ${m.lastMarkDate}`
                    : 'Value · at cost, never marked',
                  value: fmtMoney(m.unrealized, m.currency),
                },
                { label: 'Realized', value: fmtMoney(m.realized, m.currency) },
                { label: 'MOIC', value: fmtMultiple(m.moic) },
                { label: 'XIRR', value: fmtXirr(m.grossXirr) },
              ]
            : [
                {
                  label: 'Metrics',
                  value: `need fx for ${missing.join(', ')}`,
                  tone: 'bad',
                },
              ]
        }
      />

      <RecordBody
        rail={
          <RailSection label="Ownership">
            <OwnershipBlock ownership={h.ownership} />
          </RailSection>
        }
      >
        {missing.length > 0 ? (
          <p className="mono text-micro text-destructive">
            metrics need fx rates for {missing.join(', ')} —{' '}
            <Link to="/settings/currency" className="focus-ring underline">
              add them in Settings
            </Link>
          </p>
        ) : null}

        <EventSection
          title="Checks"
          empty="No checks recorded."
          add={<AddInvestmentDialog companyId={h.companyId} />}
          table="investment"
          rows={h.investments.map((r) => ({
            id: String(r.id),
            date: String(r.date),
            kind: 'invest',
            label: `${String(r.instrument).replace(/_/g, ' ')}${r.vehicle ? ` · ${String(r.vehicle)}` : ''}`,
            amount: fmtMoney(Number(r.amount), String(r.currency)),
            detail:
              r.shares != null
                ? `${Number(r.shares).toLocaleString()} shares`
                : r.cap != null
                  ? `cap ${fmtMoney(Number(r.cap), String(r.currency), { compact: true })}`
                  : '',
            reversedAt: r.reversedAt === null ? null : String(r.reversedAt),
            reversesId: r.reversesId === null ? null : String(r.reversesId),
            voidedBy: r.voidedBy === null ? null : String(r.voidedBy),
            voidedOn: r.voidedOn === null ? null : String(r.voidedOn),
          }))}
        />
        <EventSection
          title="Rounds"
          empty="No rounds recorded — add them to power the ownership ledger."
          add={<AddRoundDialog companyId={h.companyId} />}
          rows={h.rounds.map((r) => ({
            id: String(r.id),
            date: String(r.date),
            kind: 'round',
            label: String(r.kind),
            amount:
              r.raised != null
                ? `raised ${fmtMoney(Number(r.raised), String(r.currency ?? 'USD'), { compact: true })}`
                : '',
            detail:
              r.sharesOutstanding != null
                ? `${Number(r.sharesOutstanding).toLocaleString()} FD shares`
                : '',
            reversedAt: null,
            reversesId: null,
            voidedBy: null,
            voidedOn: null,
          }))}
        />
        <EventSection
          title="Marks"
          empty="Never marked — value shows at cost, staleness on purpose."
          add={<AddMarkDialog holdingId={h.id} />}
          table="mark"
          rows={h.marks.map((r) => ({
            id: String(r.id),
            date: String(r.date),
            kind: 'mark',
            label: String(r.basis).replace(/_/g, ' '),
            amount: fmtMoney(Number(r.fairValue), String(r.currency)),
            detail: '',
            reversedAt: r.reversedAt === null ? null : String(r.reversedAt),
            reversesId: r.reversesId === null ? null : String(r.reversesId),
            voidedBy: r.voidedBy === null ? null : String(r.voidedBy),
            voidedOn: r.voidedOn === null ? null : String(r.voidedOn),
          }))}
        />
        <EventSection
          title="Distributions"
          empty="Nothing realized yet."
          add={<AddDistributionDialog holdingId={h.id} />}
          table="distribution"
          rows={h.distributions.map((r) => ({
            id: String(r.id),
            date: String(r.date),
            kind: 'distrib',
            label: String(r.kind),
            amount: `${Number(r.amount) < 0 ? '' : '+'}${fmtMoney(Number(r.amount), String(r.currency))}`,
            detail:
              r.sharesSold != null
                ? `${Number(r.sharesSold).toLocaleString()} shares sold`
                : '',
            reversedAt: r.reversedAt === null ? null : String(r.reversedAt),
            reversesId: r.reversesId === null ? null : String(r.reversesId),
            voidedBy: r.voidedBy === null ? null : String(r.voidedBy),
            voidedOn: r.voidedOn === null ? null : String(r.voidedOn),
          }))}
        />
      </RecordBody>
    </div>
  )
}

function OwnershipBlock({ ownership }: { ownership: Holding['ownership'] }) {
  if (ownership.kind === 'cost_basis_only') {
    return (
      <RailEmpty>
        Cost basis only — unconverted instrument, a percentage would be a guess.
      </RailEmpty>
    )
  }
  if (ownership.kind === 'implied') {
    return (
      <>
        <RailRow label="Implied" value={`~${fmtPct(ownership.pct)}`} />
        <RailEmpty>Post-money SAFE, locked at signing.</RailEmpty>
      </>
    )
  }
  return (
    <ol>
      {ownership.history.map((p) => (
        <li
          key={p.date}
          className="flex h-row items-center gap-3 border-t border-rule"
        >
          <span className="w-20 shrink-0 mono text-micro text-graphite">
            {p.date}
          </span>
          <span className="min-w-0 flex-1 truncate text-ui">{p.roundKind}</span>
          <span className="mono text-micro text-graphite">
            {p.ourShares.toLocaleString()} /{' '}
            {p.sharesOutstanding.toLocaleString()}
          </span>
          <span className="w-14 shrink-0 numeric text-ui font-medium">
            {fmtPct(p.pct)}
          </span>
        </li>
      ))}
    </ol>
  )
}
/** The three tables a correction can be appended to (D12). */
type VoidableTable = 'investment' | 'mark' | 'distribution'

type EventRow = {
  id: string
  date: string
  kind: string
  label: string
  amount: string
  detail: string
  /** Non-null on a struck original: when the void was written. */
  reversedAt: string | null
  /** Non-null on the compensating row: the entry it voids. */
  reversesId: string | null
  voidedBy: string | null
  voidedOn: string | null
}

/**
 * One append-only ledger per event kind: date, kind, entry, amount, detail.
 * There is still no edit and no delete affordance. A wrong entry is voided
 * (D12, SPA-150) — the original stays, struck, with its compensating row
 * immediately beneath it naming who voided it and when, so the record of
 * what was believed and when survives the correction.
 *
 * `table` is null for Rounds, which are not summed events and carry no
 * `reverses_id`; that section draws no Void.
 */
function EventSection({
  title,
  empty,
  add,
  rows,
  table,
}: {
  title: string
  empty: string
  add: React.ReactNode
  rows: Array<EventRow>
  table?: VoidableTable | undefined
}) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)

  async function onVoid(r: EventRow) {
    if (table === undefined) return
    const ok = await confirm({
      title: `Void this ${title.toLowerCase().replace(/s$/, '')}?`,
      body: 'Nothing is edited and nothing is deleted. A compensating entry is appended, dated as this one is dated, and both stay on the record.',
      rows: [{ name: r.label, meta: `${r.date.slice(0, 10)} · ${r.amount}` }],
      action: 'Void',
    })
    if (!ok) return
    setBusy(r.id)
    try {
      await voidLedgerEvent({ data: { table, id: r.id } })
      toast('Voided — the correction is on the record')
      void router.invalidate()
    } catch (err) {
      // The server names the refusal ("already voided", "a reversal cannot
      // be reversed"); never a generic toast.
      toast(err instanceof Error ? err.message : 'Could not void this entry')
    } finally {
      setBusy(null)
    }
  }

  const live = rows.filter(
    (r) => r.reversesId === null && r.reversedAt === null,
  )
  return (
    <LedgerSection
      label={title}
      count={`${live.length} entr${live.length === 1 ? 'y' : 'ies'}${
        rows.length > live.length
          ? ` · ${rows.length - live.length} voided`
          : ''
      }`}
      link={add}
    >
      {confirmDialog}
      {rows.length === 0 ? (
        <li className="py-2 text-label text-graphite">{empty}</li>
      ) : (
        rows.map((r, i) => {
          const struck = r.reversedAt !== null
          const isReversal = r.reversesId !== null
          return (
            <LedgerRow key={r.id} last={i === rows.length - 1}>
              <span
                className={cn(
                  'w-24 shrink-0 mono text-micro text-graphite',
                  isReversal && 'pl-3',
                )}
              >
                {r.date.slice(0, 10)}
              </span>
              <span
                className={cn(
                  'w-16 shrink-0 mono text-micro font-medium uppercase',
                  (struck || isReversal) && 'text-graphite',
                )}
              >
                {isReversal ? 'void' : r.kind}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-ui',
                  struck && 'text-graphite line-through',
                  isReversal && 'text-graphite',
                )}
              >
                {isReversal
                  ? `voids the ${r.label}${r.voidedBy ? ` · ${r.voidedBy}` : ''}${
                      r.voidedOn ? ` · ${r.voidedOn}` : ''
                    }`
                  : r.label}
              </span>
              {r.detail && !isReversal ? (
                <span className="shrink-0 mono text-micro text-graphite">
                  {r.detail}
                </span>
              ) : null}
              {table !== undefined && !struck && !isReversal ? (
                <button
                  type="button"
                  disabled={busy === r.id}
                  onClick={() => void onVoid(r)}
                  className="focus-ring shrink-0 mono text-micro text-graphite hover:text-destructive hover:underline"
                >
                  void
                </button>
              ) : null}
              <span
                className={cn(
                  'w-32 shrink-0 numeric text-ui',
                  struck && 'text-graphite line-through',
                  isReversal && 'text-graphite',
                )}
              >
                {r.amount}
              </span>
            </LedgerRow>
          )
        })
      )}
    </LedgerSection>
  )
}

/* ---------- add-event dialogs: code-owned forms, not the registry ---------- */

function useEventForm(onDone: () => void) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(fn: () => Promise<unknown>, doneMsg: string) {
    setPending(true)
    setError(null)
    try {
      await fn()
      setOpen(false)
      toast(doneMsg)
      onDone()
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }
  return { open, setOpen, pending, error, run }
}

function AddTrigger({
  label,
  ...props
}: { label: string } & React.ComponentProps<typeof Button>) {
  // Spreads DialogTrigger's asChild-injected props (onClick, aria-*)
  // through to the real button — without this the dialog never opens.
  return (
    <button
      type="button"
      className="focus-ring flex items-center gap-1 mono text-micro text-primary hover:underline"
      {...props}
    >
      <Plus className="size-3" strokeWidth={2} />
      {label.toLowerCase()}
    </button>
  )
}

function Field({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

/**
 * The three closed vocabularies the event forms write. A `<select>` hands
 * back a string; these narrow it once, so the form state already holds the
 * server's type and the submit needs no assertion.
 */
const INSTRUMENTS = [
  'priced',
  'safe_post_money',
  'safe_pre_money',
  'ccd',
] as const
type Instrument = (typeof INSTRUMENTS)[number]
const toInstrument = (v: string): Instrument =>
  INSTRUMENTS.find((i) => i === v) ?? 'priced'

const MARK_BASES = ['round_price', 'manual', '409a'] as const
type MarkBasis = (typeof MARK_BASES)[number]
const toMarkBasis = (v: string): MarkBasis =>
  MARK_BASES.find((b) => b === v) ?? 'round_price'

const DIST_KINDS = ['exit', 'secondary', 'dividend', 'writeoff'] as const
type DistKind = (typeof DIST_KINDS)[number]
const toDistKind = (v: string): DistKind =>
  DIST_KINDS.find((k) => k === v) ?? 'exit'

function AddInvestmentDialog({ companyId }: { companyId: string }) {
  const f = useEventForm(() => {})
  const [form, setForm] = useState<{
    date: string
    amount: string
    currency: string
    instrument: Instrument
    shares: string
    cap: string
    vehicle: string
  }>({
    date: '',
    amount: '',
    currency: 'USD',
    instrument: 'priced',
    shares: '',
    cap: '',
    vehicle: '',
  })
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((s) => ({ ...s, [k]: e.target.value }))
  return (
    <Dialog open={f.open} onOpenChange={f.setOpen}>
      <DialogTrigger asChild>
        <AddTrigger label="Add check" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a check</DialogTitle>
          <DialogDescription>
            An append-only investment event on this holding.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void f.run(
              () =>
                addInvestment({
                  data: {
                    companyId,
                    date: form.date,
                    amount: Number(form.amount),
                    currency: form.currency,
                    instrument: form.instrument,
                    ...(form.shares ? { shares: Number(form.shares) } : {}),
                    ...(form.cap ? { cap: Number(form.cap) } : {}),
                    ...(form.vehicle ? { vehicle: form.vehicle } : {}),
                  },
                }),
              'Check recorded',
            )
          }}
        >
          <Field id="inv-date" label="Date">
            <Input
              id="inv-date"
              type="date"
              required
              value={form.date}
              onChange={set('date')}
            />
          </Field>
          <Field id="inv-amount" label="Amount">
            <Input
              id="inv-amount"
              type="number"
              required
              min="0"
              step="any"
              value={form.amount}
              onChange={set('amount')}
            />
          </Field>
          <Field id="inv-ccy" label="Currency">
            <Input
              id="inv-ccy"
              required
              maxLength={3}
              value={form.currency}
              onChange={set('currency')}
            />
          </Field>
          <Field id="inv-instrument" label="Instrument">
            <select
              id="inv-instrument"
              className="focus-ring h-8 w-full rounded-md border border-rule bg-transparent px-2.5 text-ui"
              value={form.instrument}
              onChange={(e) =>
                setForm((s) => ({
                  ...s,
                  instrument: toInstrument(e.target.value),
                }))
              }
            >
              <option value="priced">Priced</option>
              <option value="safe_post_money">SAFE (post-money)</option>
              <option value="safe_pre_money">SAFE (pre-money)</option>
              <option value="ccd">CCD</option>
            </select>
          </Field>
          {form.instrument === 'priced' ? (
            <Field id="inv-shares" label="Shares">
              <Input
                id="inv-shares"
                type="number"
                min="0"
                step="any"
                value={form.shares}
                onChange={set('shares')}
              />
            </Field>
          ) : (
            <Field id="inv-cap" label="Valuation cap">
              <Input
                id="inv-cap"
                type="number"
                min="0"
                step="any"
                value={form.cap}
                onChange={set('cap')}
              />
            </Field>
          )}
          <Field id="inv-vehicle" label="Vehicle (optional)">
            <Input
              id="inv-vehicle"
              value={form.vehicle}
              onChange={set('vehicle')}
              placeholder="Fund I"
            />
          </Field>
          {f.error ? (
            <p role="alert" className="col-span-2 text-ui text-destructive">
              {f.error}
            </p>
          ) : null}
          <DialogFooter className="col-span-2">
            <Button type="submit" disabled={f.pending}>
              {f.pending ? 'Saving…' : 'Record check'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AddRoundDialog({ companyId }: { companyId: string }) {
  const f = useEventForm(() => {})
  const [form, setForm] = useState({
    date: '',
    kind: '',
    raised: '',
    currency: 'USD',
    postMoney: '',
    pricePerShare: '',
    sharesOutstanding: '',
  })
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((s) => ({ ...s, [k]: e.target.value }))
  return (
    <Dialog open={f.open} onOpenChange={f.setOpen}>
      <DialogTrigger asChild>
        <AddTrigger label="Add round" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a round</DialogTitle>
          <DialogDescription>
            A financing event — the fully-diluted count powers the ownership
            ledger.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void f.run(
              () =>
                addRound({
                  data: {
                    companyId,
                    date: form.date,
                    kind: form.kind,
                    ...(form.raised ? { raised: Number(form.raised) } : {}),
                    ...(form.currency ? { currency: form.currency } : {}),
                    ...(form.postMoney
                      ? { postMoney: Number(form.postMoney) }
                      : {}),
                    pricePerShare: form.pricePerShare
                      ? Number(form.pricePerShare)
                      : undefined,
                    sharesOutstanding: form.sharesOutstanding
                      ? Number(form.sharesOutstanding)
                      : undefined,
                  },
                }),
              'Round recorded',
            )
          }}
        >
          <Field id="rd-date" label="Date">
            <Input
              id="rd-date"
              type="date"
              required
              value={form.date}
              onChange={set('date')}
            />
          </Field>
          <Field id="rd-kind" label="Round">
            <Input
              id="rd-kind"
              required
              value={form.kind}
              onChange={set('kind')}
              placeholder="Seed, Series A…"
            />
          </Field>
          <Field id="rd-raised" label="Raised (optional)">
            <Input
              id="rd-raised"
              type="number"
              min="0"
              step="any"
              value={form.raised}
              onChange={set('raised')}
            />
          </Field>
          <Field id="rd-ccy" label="Currency">
            <Input
              id="rd-ccy"
              maxLength={3}
              value={form.currency}
              onChange={set('currency')}
            />
          </Field>
          <Field id="rd-post" label="Post-money (optional)">
            <Input
              id="rd-post"
              type="number"
              min="0"
              step="any"
              value={form.postMoney}
              onChange={set('postMoney')}
            />
          </Field>
          <Field id="rd-fd" label="FD shares outstanding">
            <Input
              id="rd-fd"
              type="number"
              min="0"
              step="any"
              value={form.sharesOutstanding}
              onChange={set('sharesOutstanding')}
            />
          </Field>
          {f.error ? (
            <p role="alert" className="col-span-2 text-ui text-destructive">
              {f.error}
            </p>
          ) : null}
          <DialogFooter className="col-span-2">
            <Button type="submit" disabled={f.pending}>
              {f.pending ? 'Saving…' : 'Record round'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AddMarkDialog({ holdingId }: { holdingId: string }) {
  const f = useEventForm(() => {})
  const [form, setForm] = useState<{
    date: string
    fairValue: string
    currency: string
    basis: MarkBasis
  }>({
    date: '',
    fairValue: '',
    currency: 'USD',
    basis: 'round_price',
  })
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((s) => ({ ...s, [k]: e.target.value }))
  return (
    <Dialog open={f.open} onOpenChange={f.setOpen}>
      <DialogTrigger asChild>
        <AddTrigger label="Add mark" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a mark</DialogTitle>
          <DialogDescription>
            Fair value of the whole position at a date. Marks append — history
            never rewrites.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void f.run(
              () =>
                addMark({
                  data: {
                    holdingId,
                    date: form.date,
                    fairValue: Number(form.fairValue),
                    currency: form.currency,
                    basis: form.basis,
                  },
                }),
              'Mark recorded',
            )
          }}
        >
          <Field id="mk-date" label="Date">
            <Input
              id="mk-date"
              type="date"
              required
              value={form.date}
              onChange={set('date')}
            />
          </Field>
          <Field id="mk-value" label="Fair value">
            <Input
              id="mk-value"
              type="number"
              required
              min="0"
              step="any"
              value={form.fairValue}
              onChange={set('fairValue')}
            />
          </Field>
          <Field id="mk-ccy" label="Currency">
            <Input
              id="mk-ccy"
              required
              maxLength={3}
              value={form.currency}
              onChange={set('currency')}
            />
          </Field>
          <Field id="mk-basis" label="Basis">
            <select
              id="mk-basis"
              className="focus-ring h-8 w-full rounded-md border border-rule bg-transparent px-2.5 text-ui"
              value={form.basis}
              onChange={(e) =>
                setForm((s) => ({ ...s, basis: toMarkBasis(e.target.value) }))
              }
            >
              <option value="round_price">Round price</option>
              <option value="manual">Manual</option>
              <option value="409a">409A</option>
            </select>
          </Field>
          {f.error ? (
            <p role="alert" className="col-span-2 text-ui text-destructive">
              {f.error}
            </p>
          ) : null}
          <DialogFooter className="col-span-2">
            <Button type="submit" disabled={f.pending}>
              {f.pending ? 'Saving…' : 'Record mark'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AddDistributionDialog({ holdingId }: { holdingId: string }) {
  const f = useEventForm(() => {})
  const [form, setForm] = useState<{
    date: string
    amount: string
    currency: string
    kind: DistKind
    sharesSold: string
  }>({
    date: '',
    amount: '',
    currency: 'USD',
    kind: 'exit',
    sharesSold: '',
  })
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((s) => ({ ...s, [k]: e.target.value }))
  const isWriteoff = form.kind === 'writeoff'
  return (
    <Dialog open={f.open} onOpenChange={f.setOpen}>
      <DialogTrigger asChild>
        <AddTrigger label="Add distribution" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a distribution</DialogTitle>
          <DialogDescription>
            Realized proceeds — or the one honest click: a write-off.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void f.run(
              () =>
                addDistribution({
                  data: {
                    holdingId,
                    date: form.date,
                    amount: isWriteoff ? 0 : Number(form.amount),
                    currency: form.currency,
                    kind: form.kind,
                    sharesSold: form.sharesSold
                      ? Number(form.sharesSold)
                      : undefined,
                  },
                }),
              isWriteoff ? 'Written off' : 'Distribution recorded',
            )
          }}
        >
          <Field id="ds-kind" label="Kind">
            <select
              id="ds-kind"
              className="focus-ring h-8 w-full rounded-md border border-rule bg-transparent px-2.5 text-ui"
              value={form.kind}
              onChange={(e) =>
                setForm((s) => ({ ...s, kind: toDistKind(e.target.value) }))
              }
            >
              <option value="exit">Exit</option>
              <option value="secondary">Secondary</option>
              <option value="dividend">Dividend</option>
              <option value="writeoff">Write-off</option>
            </select>
          </Field>
          <Field id="ds-date" label="Date">
            <Input
              id="ds-date"
              type="date"
              required
              value={form.date}
              onChange={set('date')}
            />
          </Field>
          {!isWriteoff ? (
            <>
              <Field id="ds-amount" label="Amount">
                <Input
                  id="ds-amount"
                  type="number"
                  required
                  min="0"
                  step="any"
                  value={form.amount}
                  onChange={set('amount')}
                />
              </Field>
              <Field id="ds-ccy" label="Currency">
                <Input
                  id="ds-ccy"
                  required
                  maxLength={3}
                  value={form.currency}
                  onChange={set('currency')}
                />
              </Field>
              <Field id="ds-shares" label="Shares sold (optional)">
                <Input
                  id="ds-shares"
                  type="number"
                  min="0"
                  step="any"
                  value={form.sharesSold}
                  onChange={set('sharesSold')}
                />
              </Field>
            </>
          ) : (
            <p className="col-span-2 self-center text-ui text-graphite">
              Marks the position to zero. The history — and the lesson — stays.
            </p>
          )}
          {f.error ? (
            <p role="alert" className="col-span-2 text-ui text-destructive">
              {f.error}
            </p>
          ) : null}
          <DialogFooter className="col-span-2">
            <Button
              type="submit"
              disabled={f.pending}
              variant={isWriteoff ? 'destructive' : 'default'}
            >
              {f.pending ? 'Saving…' : isWriteoff ? 'Write off' : 'Record'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
