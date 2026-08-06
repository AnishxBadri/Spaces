import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
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
} from '#/lib/server-fns'
import {
  fmtDate,
  fmtMoney,
  fmtMultiple,
  fmtPct,
  fmtXirr,
} from '#/lib/portfolio/format'

export const Route = createFileRoute('/_app/portfolio_/$holdingId')({
  loader: async ({ params }) => getHolding({ data: { id: params.holdingId } }),
  component: HoldingPage,
})

type Holding = Awaited<ReturnType<typeof getHolding>>

function HoldingPage() {
  const h = Route.useLoaderData()
  const m = h.metrics.ok ? h.metrics.metrics : null

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6 md:px-8">
      <Link
        to="/portfolio"
        className="focus-ring mb-4 inline-flex items-center gap-1.5 text-ui text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ArrowLeft className="size-4" strokeWidth={2} />
        Portfolio
      </Link>

      <div className="mb-1 flex items-baseline justify-between gap-4">
        <h1 className="text-title font-semibold">{h.companyName}</h1>
        <Link
          to="/companies/$companyId"
          params={{ companyId: h.companyId }}
          className="focus-ring text-ui text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          Company record →
        </Link>
      </div>
      <p className="mb-6 text-ui text-muted-foreground">
        Holding since {fmtDate(h.openedAt)}
        {m?.writtenOff ? ' · written off' : ''}
      </p>

      {h.metrics.ok === false ? (
        <p className="mb-6 text-ui text-destructive">
          Metrics need fx rates for:{' '}
          {[...new Set(h.metrics.missingRates.map((r) => r.currency))].join(
            ', ',
          )}{' '}
          (Settings → FX rates)
        </p>
      ) : null}

      {m ? (
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Invested" value={fmtMoney(m.costBasis, m.currency)} />
          <Stat
            label="Current value"
            value={fmtMoney(m.unrealized, m.currency)}
            hint={
              m.lastMarkDate
                ? `marked ${fmtDate(m.lastMarkDate)}`
                : 'at cost — never marked'
            }
          />
          <Stat label="Realized" value={fmtMoney(m.realized, m.currency)} />
          <Stat
            label="MOIC · XIRR"
            value={`${fmtMultiple(m.moic)} · ${fmtXirr(m.grossXirr)}`}
          />
        </div>
      ) : null}

      <OwnershipBlock ownership={h.ownership} />

      <EventSection
        title="Checks"
        empty="No checks recorded."
        add={<AddInvestmentDialog companyId={h.companyId} />}
        rows={h.investments.map((i) => ({
          id: String(i.id),
          date: String(i.date),
          label: `${fmtMoney(Number(i.amount), String(i.currency))} · ${String(
            i.instrument,
          ).replace(/_/g, ' ')}${i.vehicle ? ` · ${String(i.vehicle)}` : ''}`,
          detail:
            i.shares != null
              ? `${Number(i.shares).toLocaleString()} shares`
              : i.cap != null
                ? `cap ${fmtMoney(Number(i.cap), String(i.currency), { compact: true })}`
                : '',
        }))}
      />
      <EventSection
        title="Rounds"
        empty="No rounds recorded — add them to power the ownership ledger."
        add={<AddRoundDialog companyId={h.companyId} />}
        rows={h.rounds.map((r) => ({
          id: String(r.id),
          date: String(r.date),
          label: `${String(r.kind)}${
            r.raised != null
              ? ` · raised ${fmtMoney(Number(r.raised), String(r.currency ?? 'USD'), { compact: true })}`
              : ''
          }`,
          detail:
            r.sharesOutstanding != null
              ? `${Number(r.sharesOutstanding).toLocaleString()} FD shares`
              : '',
        }))}
      />
      <EventSection
        title="Marks"
        empty="Never marked — value shows at cost, staleness on purpose."
        add={<AddMarkDialog holdingId={h.id} />}
        rows={h.marks.map((r) => ({
          id: String(r.id),
          date: String(r.date),
          label: fmtMoney(Number(r.fairValue), String(r.currency)),
          detail: String(r.basis).replace(/_/g, ' '),
        }))}
      />
      <EventSection
        title="Distributions"
        empty="Nothing realized yet."
        add={<AddDistributionDialog holdingId={h.id} />}
        rows={h.distributions.map((r) => ({
          id: String(r.id),
          date: String(r.date),
          label: `${fmtMoney(Number(r.amount), String(r.currency))} · ${String(r.kind)}`,
          detail:
            r.sharesSold != null
              ? `${Number(r.sharesSold).toLocaleString()} shares sold`
              : '',
        }))}
      />
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="text-label text-muted-foreground">{label}</div>
      <div className="text-ui tabular mt-1 font-medium">{value}</div>
      {hint ? (
        <div className="mt-0.5 text-label text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  )
}

function OwnershipBlock({ ownership }: { ownership: Holding['ownership'] }) {
  if (ownership.kind === 'cost_basis_only') {
    return (
      <p className="mb-8 text-ui text-muted-foreground">
        Ownership: cost basis only — unconverted instrument, a percentage would
        be a guess.
      </p>
    )
  }
  if (ownership.kind === 'implied') {
    return (
      <p className="mb-8 text-ui">
        Implied ownership{' '}
        <span className="tabular font-medium">~{fmtPct(ownership.pct)}</span>
        <span className="text-muted-foreground">
          {' '}
          — post-money SAFE, locked at signing
        </span>
      </p>
    )
  }
  return (
    <div className="mb-8">
      <h2 className="mb-2 text-ui font-semibold">Ownership</h2>
      <ol className="space-y-1">
        {ownership.history.map((p) => (
          <li key={p.date} className="flex items-baseline gap-3 text-ui">
            <span className="tabular w-24 shrink-0 text-muted-foreground">
              {fmtDate(p.date)}
            </span>
            <span className="min-w-24">{p.roundKind}</span>
            <span className="tabular font-medium">{fmtPct(p.pct)}</span>
            <span className="text-label text-muted-foreground">
              {p.ourShares.toLocaleString()} /{' '}
              {p.sharesOutstanding.toLocaleString()} FD
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function EventSection({
  title,
  empty,
  add,
  rows,
}: {
  title: string
  empty: string
  add: React.ReactNode
  rows: Array<{ id: string; date: string; label: string; detail: string }>
}) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-ui font-semibold">{title}</h2>
        {add}
      </div>
      {rows.length === 0 ? (
        <p className="text-ui text-muted-foreground">{empty}</p>
      ) : (
        <ol className="divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-baseline gap-3 px-4 py-2.5">
              <span className="tabular w-24 shrink-0 text-label text-muted-foreground">
                {fmtDate(r.date)}
              </span>
              <span className="text-ui">{r.label}</span>
              {r.detail ? (
                <span className="ml-auto text-label text-muted-foreground">
                  {r.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
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
      router.invalidate()
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
    <Button size="sm" variant="outline" {...props}>
      <Plus className="size-4" strokeWidth={2} />
      {label}
    </Button>
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

function AddInvestmentDialog({ companyId }: { companyId: string }) {
  const f = useEventForm(() => {})
  const [form, setForm] = useState({
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
            f.run(
              () =>
                addInvestment({
                  data: {
                    companyId,
                    date: form.date,
                    amount: Number(form.amount),
                    currency: form.currency,
                    instrument: form.instrument as
                      'priced' | 'safe_post_money' | 'safe_pre_money' | 'ccd',
                    shares: form.shares ? Number(form.shares) : undefined,
                    cap: form.cap ? Number(form.cap) : undefined,
                    vehicle: form.vehicle || undefined,
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
              className="focus-ring h-9 w-full rounded-md border border-input bg-transparent px-3 text-ui"
              value={form.instrument}
              onChange={(e) =>
                setForm((s) => ({ ...s, instrument: e.target.value }))
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
            f.run(
              () =>
                addRound({
                  data: {
                    companyId,
                    date: form.date,
                    kind: form.kind,
                    raised: form.raised ? Number(form.raised) : undefined,
                    currency: form.currency || undefined,
                    postMoney: form.postMoney
                      ? Number(form.postMoney)
                      : undefined,
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
  const [form, setForm] = useState({
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
            f.run(
              () =>
                addMark({
                  data: {
                    holdingId,
                    date: form.date,
                    fairValue: Number(form.fairValue),
                    currency: form.currency,
                    basis: form.basis as 'round_price' | 'manual' | '409a',
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
              className="focus-ring h-9 w-full rounded-md border border-input bg-transparent px-3 text-ui"
              value={form.basis}
              onChange={(e) =>
                setForm((s) => ({ ...s, basis: e.target.value }))
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
  const [form, setForm] = useState({
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
            f.run(
              () =>
                addDistribution({
                  data: {
                    holdingId,
                    date: form.date,
                    amount: isWriteoff ? 0 : Number(form.amount),
                    currency: form.currency,
                    kind: form.kind as
                      'exit' | 'secondary' | 'dividend' | 'writeoff',
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
              className="focus-ring h-9 w-full rounded-md border border-input bg-transparent px-3 text-ui"
              value={form.kind}
              onChange={(e) => setForm((s) => ({ ...s, kind: e.target.value }))}
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
            <p className="col-span-2 self-center text-ui text-muted-foreground">
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
