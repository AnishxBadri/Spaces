import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { HandCoins, Layers } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { EmptyRow } from '#/components/ledger-section'
import {
  EventSection,
  HoldingFigures,
} from '#/components/holding/holding-ledger'
import {
  DitherMark,
  RailRow,
  RailSection,
  RecordBody,
  RecordHeadPending,
  RecordHeader,
} from '#/components/record/record-parts'
import { HoldingHeadActions } from '#/components/record/record-heads'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { Label } from '#/components/ui/label'
import { Select } from '#/components/ui/select'
import {
  addDistribution,
  addInvestment,
  addMark,
  addRound,
  getHolding,
} from '#/lib/server-fns'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { usePageActions } from '#/lib/page-actions'
import {
  holdingFigures,
  holdingSearch,
  instrumentLabel,
} from '#/lib/portfolio/figures'
import { fmtMoney, fmtPct } from '@spaces/core/portfolio/format'

/**
 * A holding: the company's position, one view with no tab bar. The figures
 * row and its as-of day top the pane; under it the Checks, Marks,
 * Distributions and Rounds ledgers; the ownership ledger is the rail.
 * `?asOf=` reads every figure and the ownership as they stood that day.
 */
export const Route = createFileRoute('/_app/portfolio_/$holdingId')({
  validateSearch: holdingSearch,
  loaderDeps: ({ search }) => ({ asOf: search.asOf }),
  loader: async ({ params, deps }) =>
    getHolding({
      data: {
        id: params.holdingId,
        ...(deps.asOf === undefined ? {} : { asOf: deps.asOf }),
      },
    }),
  pendingComponent: () => <RecordHeadPending kind="Holding" />,
  component: HoldingPage,
})

type Holding = Awaited<ReturnType<typeof getHolding>>

/** Locale-pinned, so the server and the browser print the same digits. */
const count = (n: number) => n.toLocaleString('en-US')

function HoldingPage() {
  const h = Route.useLoaderData()
  const { asOf } = Route.useSearch()
  const navigate = Route.useNavigate()
  const m = h.metrics.ok ? h.metrics.metrics : null
  const router = useRouter()
  const { today } = useClock()
  // The rarer entries open from the head's ···, or from an empty section.
  const [adding, setAdding] = useState<'distribution' | 'round' | null>(null)
  usePageActions(
    [
      {
        id: 'company',
        label: 'Open the company record',
        run: () =>
          void router.navigate({
            to: '/companies/$companyId',
            params: { companyId: h.companyId },
          }),
      },
    ],
    h.companyName,
  )

  const missing =
    h.metrics.ok === false
      ? [...new Set(h.metrics.missingRates.map((r) => r.currency))]
      : []

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        stamp={{ kind: 'Holding' }}
        actions={
          <HoldingHeadActions
            name={h.companyName}
            recordMark={(trigger) => (
              <AddMarkDialog holdingId={h.id} trigger={trigger} />
            )}
            recordCheck={(trigger) => (
              <AddInvestmentDialog companyId={h.companyId} trigger={trigger} />
            )}
            more={[
              {
                label: 'Record a distribution…',
                icon: <HandCoins className="size-4" />,
                onSelect: () => setAdding('distribution'),
                opens: true,
              },
              {
                label: 'Record a round…',
                icon: <Layers className="size-4" />,
                onSelect: () => setAdding('round'),
                opens: true,
              },
            ]}
          />
        }
        mark={<DitherMark />}
        name={
          // The holding is the company's position: its title is the way
          // to the company.
          <Link
            to="/companies/$companyId"
            params={{ companyId: h.companyId }}
            className="focus-ring hover:underline"
          >
            {h.companyName}
          </Link>
        }
        badges={
          missing.length > 0 ? (
            // Amber is named, not resolved: `optionColor` returns a stored
            // colour unchanged, so a badge the instrument colours for itself
            // goes through the same primitive as the data-coloured ones.
            <Badge option={{ color: 'amber' }} index={0} className="shrink-0">
              Unpriced · {missing.join(', ')}
            </Badge>
          ) : null
        }
      />

      <AddDistributionDialog
        holdingId={h.id}
        open={adding === 'distribution'}
        onOpenChange={(open) => setAdding(open ? 'distribution' : null)}
      />
      <AddRoundDialog
        companyId={h.companyId}
        open={adding === 'round'}
        onOpenChange={(open) => setAdding(open ? 'round' : null)}
      />

      <RecordBody
        rail={
          <RailSection
            label="Ownership"
            meta={
              h.ownership.kind === 'actual' ? <span>Fully diluted</span> : null
            }
          >
            <OwnershipBlock ownership={h.ownership} />
          </RailSection>
        }
      >
        <HoldingFigures
          figures={m === null ? [] : holdingFigures(m, today)}
          asOf={asOf ?? null}
          onAsOf={(day) =>
            void navigate({
              search: day === null ? {} : { asOf: day },
              replace: true,
              resetScroll: false,
            })
          }
        >
          {missing.length > 0 ? (
            <p className="text-ui text-destructive">
              Figures need FX rates for {missing.join(', ')} ·{' '}
              <Link to="/settings/currency" className="focus-ring underline">
                Add them in Settings
              </Link>
            </p>
          ) : null}
        </HoldingFigures>

        <div className="flex flex-col gap-8">
          <EventSection
            title="Checks"
            table="investment"
            rows={h.investments.map((r) => ({
              id: r.id,
              date: r.date,
              label: [instrumentLabel(r.instrument), r.vehicle]
                .filter((part) => part !== null && part !== '')
                .join(' · '),
              amount: fmtMoney(r.amount, r.currency),
              detail:
                r.shares !== null
                  ? `${count(r.shares)} shares`
                  : r.cap !== null
                    ? `cap ${fmtMoney(r.cap, r.currency, { compact: true })}`
                    : '',
              reversedAt: r.reversedAt,
              reversesId: r.reversesId,
              voidedBy: r.voidedBy,
              voidedOn: r.voidedOn,
            }))}
          />
          <EventSection
            title="Marks"
            table="mark"
            rows={h.marks.map((r) => ({
              id: r.id,
              date: r.date,
              label: labelOf(MARK_BASIS_ITEMS, r.basis),
              amount: fmtMoney(r.fairValue, r.currency),
              detail: '',
              reversedAt: r.reversedAt,
              reversesId: r.reversesId,
              voidedBy: r.voidedBy,
              voidedOn: r.voidedOn,
            }))}
          />
          <EventSection
            title="Distributions"
            table="distribution"
            empty={
              <EmptyRow
                name="Distributions"
                onAdd={() => setAdding('distribution')}
              />
            }
            rows={h.distributions.map((r) => ({
              id: r.id,
              date: r.date,
              label: labelOf(DIST_KIND_ITEMS, r.kind),
              amount: fmtMoney(r.amount, r.currency),
              detail:
                r.sharesSold !== null
                  ? `${count(r.sharesSold)} shares sold`
                  : '',
              reversedAt: r.reversedAt,
              reversesId: r.reversesId,
              voidedBy: r.voidedBy,
              voidedOn: r.voidedOn,
            }))}
          />
          <EventSection
            title="Rounds"
            empty={<EmptyRow name="Rounds" onAdd={() => setAdding('round')} />}
            rows={h.rounds.map((r) => ({
              id: r.id,
              date: r.date,
              label: r.kind,
              amount:
                r.raised !== null
                  ? fmtMoney(r.raised, r.currency ?? 'USD', { compact: true })
                  : '',
              detail:
                r.sharesOutstanding !== null
                  ? `${count(r.sharesOutstanding)} FD shares`
                  : '',
              reversedAt: null,
              reversesId: null,
              voidedBy: null,
              voidedOn: null,
            }))}
          />
        </div>
      </RecordBody>
    </div>
  )
}

/** A rail figure whose explanation is its tooltip, not a line under it. */
function ExplainedFigure({ figure, why }: { figure: string; why: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="focus-ring cursor-default">
          {figure}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{why}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Fully diluted ownership by round: the day, the round, our shares over
 * the shares outstanding, and the percentage.
 */
function OwnershipBlock({ ownership }: { ownership: Holding['ownership'] }) {
  const { today } = useClock()
  if (ownership.kind === 'cost_basis_only') {
    return (
      <RailRow
        label="Cost basis only"
        value={
          <ExplainedFigure
            figure="—"
            why="An unconverted instrument has no percentage yet; one would be a guess."
          />
        }
      />
    )
  }
  if (ownership.kind === 'implied') {
    return (
      <RailRow
        label="Implied"
        value={
          <ExplainedFigure
            figure={`~${fmtPct(ownership.pct)}`}
            why="Post-money SAFE, locked at signing."
          />
        }
      />
    )
  }
  return (
    <ol>
      {ownership.history.map((p) => (
        <li
          key={p.date}
          data-ownership
          className="flex h-row items-center gap-3 border-t border-rule"
        >
          <span className="w-20 shrink-0 mono text-micro text-graphite">
            {formatDay(p.date, today)}
          </span>
          <span className="min-w-0 flex-1 truncate text-ui">{p.roundKind}</span>
          <span className="shrink-0 mono text-micro text-graphite">
            {count(p.ourShares)} / {count(p.sharesOutstanding)}
          </span>
          <span className="w-14 shrink-0 numeric text-right text-ui font-medium">
            {fmtPct(p.pct)}
          </span>
        </li>
      ))}
    </ol>
  )
}

/* ---------- add-event dialogs: code-owned forms, not the registry ---------- */

/** A window's open state: its own, or the page's when the page opens it. */
type Opened = { open: boolean; onOpenChange: (open: boolean) => void }

function useEventForm(controlled?: Opened) {
  const router = useRouter()
  const [own, setOwn] = useState(false)
  const open = controlled?.open ?? own
  const setOpen = controlled?.onOpenChange ?? setOwn
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(fn: () => Promise<unknown>, doneMsg: string) {
    setPending(true)
    setError(null)
    try {
      await fn()
      setOpen(false)
      toast(doneMsg)
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }
  return { open, setOpen, pending, error, run }
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
 * The three closed vocabularies the event forms write — declared once, as
 * the picker's rows. `Select<Instrument>` hands back the union member, so
 * the list is the type and the submit needs no assertion.
 */
const INSTRUMENT_ITEMS = [
  { value: 'priced', label: 'Priced' },
  { value: 'safe_post_money', label: 'SAFE (post-money)' },
  { value: 'safe_pre_money', label: 'SAFE (pre-money)' },
  { value: 'ccd', label: 'CCD' },
] as const
type Instrument = (typeof INSTRUMENT_ITEMS)[number]['value']

const MARK_BASIS_ITEMS = [
  { value: 'round_price', label: 'Round price' },
  { value: 'manual', label: 'Manual' },
  { value: '409a', label: '409A' },
] as const
type MarkBasis = (typeof MARK_BASIS_ITEMS)[number]['value']

const DIST_KIND_ITEMS = [
  { value: 'exit', label: 'Exit' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'dividend', label: 'Dividend' },
  { value: 'writeoff', label: 'Write-off' },
] as const
type DistKind = (typeof DIST_KIND_ITEMS)[number]['value']

/** A stored value's label from its picker rows, or the value itself. */
function labelOf(
  items: ReadonlyArray<{ value: string; label: string }>,
  value: string,
): string {
  return items.find((i) => i.value === value)?.label ?? value
}

function AddInvestmentDialog({
  companyId,
  trigger,
}: {
  companyId: string
  /** Its opener: the head's verb. */
  trigger: ReactNode
}) {
  const f = useEventForm()
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
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Record a check</DialogTitle>
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
            <Select
              id="inv-instrument"
              value={form.instrument}
              onChange={(instrument) => setForm((s) => ({ ...s, instrument }))}
              items={INSTRUMENT_ITEMS}
              width="content"
              className="bg-transparent"
            />
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
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={f.pending}>
              {f.pending ? 'Saving…' : 'Record check'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AddRoundDialog({
  companyId,
  ...opened
}: { companyId: string } & Opened) {
  const f = useEventForm(opened)
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
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Record a round</DialogTitle>
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
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={f.pending}>
              {f.pending ? 'Saving…' : 'Record round'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Record a mark on one holding. Opened by its `trigger`, or — with no
 * trigger, as Today's mark row opens it — held open by the caller.
 */
export function AddMarkDialog({
  holdingId,
  trigger,
  opened,
}: {
  holdingId: string
  /** Its opener: the head's verb. */
  trigger?: ReactNode
  opened?: Opened | undefined
}) {
  const f = useEventForm(opened)
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
      {trigger === undefined ? null : (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Record a mark</DialogTitle>
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
            <Select
              id="mk-basis"
              value={form.basis}
              onChange={(basis) => setForm((s) => ({ ...s, basis }))}
              items={MARK_BASIS_ITEMS}
              width="content"
              className="bg-transparent"
            />
          </Field>
          {f.error ? (
            <p role="alert" className="col-span-2 text-ui text-destructive">
              {f.error}
            </p>
          ) : null}
          <DialogFooter className="col-span-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={f.pending}>
              {f.pending ? 'Saving…' : 'Record mark'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AddDistributionDialog({
  holdingId,
  ...opened
}: { holdingId: string } & Opened) {
  const f = useEventForm(opened)
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
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Record a distribution</DialogTitle>
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
            <Select
              id="ds-kind"
              value={form.kind}
              onChange={(kind) => setForm((s) => ({ ...s, kind }))}
              items={DIST_KIND_ITEMS}
              width="content"
              className="bg-transparent"
            />
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
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
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
