import { useRouter } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { PickPopover } from '#/components/record/details-add'
import type { PickHit } from '#/components/record/details-add'
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
import { Label } from '#/components/ui/label'
import { Select, selectClasses } from '#/components/ui/select'
import { addInvestment, searchEntities } from '#/lib/server-fns'

/* The portfolio event windows' shared parts: code-owned forms, not the
   registry. Record a check lives here because the holding and the
   portfolio list both open it. */

/** A window's open state: its own, or the page's when the page opens it. */
export type Opened = { open: boolean; onOpenChange: (open: boolean) => void }

/** A portfolio event form's open state, its write and its one error line. */
export function useEventForm(controlled?: Opened) {
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

/** A labelled field in an event form. */
export function EventField({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

/**
 * The instruments a check is written in, as the picker's rows.
 * `Select<Instrument>` hands back the union member, so the list is the type
 * and the submit needs no assertion.
 */
const INSTRUMENT_ITEMS = [
  { value: 'priced', label: 'Priced' },
  { value: 'safe_post_money', label: 'SAFE (post-money)' },
  { value: 'safe_pre_money', label: 'SAFE (pre-money)' },
  { value: 'ccd', label: 'CCD' },
] as const
type Instrument = (typeof INSTRUMENT_ITEMS)[number]['value']

/**
 * Record a check. On a holding the company is the holding's; from the
 * portfolio list it is picked here, and a company with no holding yet gets
 * one with its first check.
 */
export function RecordCheckDialog({
  company,
  trigger,
}: {
  /** The holding's company; absent, the window asks for one. */
  company?: { id: string } | undefined
  /** Its opener: the head's verb. */
  trigger: ReactNode
}) {
  const f = useEventForm()
  const [picked, setPicked] = useState<PickHit | null>(null)
  const companyId = company?.id ?? picked?.id ?? null
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
  const searchCompanies = useCallback(
    (q: string) => searchEntities({ data: { q, kinds: ['company'] } }),
    [],
  )
  return (
    <Dialog
      open={f.open}
      onOpenChange={(open) => {
        f.setOpen(open)
        if (!open) setPicked(null)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent size="s" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Record a check</DialogTitle>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (companyId === null) return
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
          {company === undefined ? (
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="inv-company">Company</Label>
              <PickPopover
                trigger={
                  <button
                    id="inv-company"
                    type="button"
                    className={selectClasses({ width: 'trigger' }).trigger}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {picked === null ? (
                        <span className="text-graphite">Pick a company</span>
                      ) : (
                        picked.name
                      )}
                    </span>
                    <ChevronDown
                      aria-hidden
                      className="size-3.5 shrink-0 text-graphite"
                      strokeWidth={1.75}
                    />
                  </button>
                }
                placeholder="Search companies…"
                search={searchCompanies}
                onPick={(hit) => {
                  setPicked(hit)
                  return Promise.resolve()
                }}
              />
            </div>
          ) : null}
          <EventField id="inv-date" label="Date">
            <Input
              id="inv-date"
              type="date"
              required
              value={form.date}
              onChange={set('date')}
            />
          </EventField>
          <EventField id="inv-amount" label="Amount">
            <Input
              id="inv-amount"
              type="number"
              required
              min="0"
              step="any"
              value={form.amount}
              onChange={set('amount')}
            />
          </EventField>
          <EventField id="inv-ccy" label="Currency">
            <Input
              id="inv-ccy"
              required
              maxLength={3}
              value={form.currency}
              onChange={set('currency')}
            />
          </EventField>
          <EventField id="inv-instrument" label="Instrument">
            <Select
              id="inv-instrument"
              value={form.instrument}
              onChange={(instrument) => setForm((s) => ({ ...s, instrument }))}
              items={INSTRUMENT_ITEMS}
              width="content"
              className="bg-transparent"
            />
          </EventField>
          {form.instrument === 'priced' ? (
            <EventField id="inv-shares" label="Shares">
              <Input
                id="inv-shares"
                type="number"
                min="0"
                step="any"
                value={form.shares}
                onChange={set('shares')}
              />
            </EventField>
          ) : (
            <EventField id="inv-cap" label="Valuation cap">
              <Input
                id="inv-cap"
                type="number"
                min="0"
                step="any"
                value={form.cap}
                onChange={set('cap')}
              />
            </EventField>
          )}
          <EventField id="inv-vehicle" label="Vehicle (optional)">
            <Input
              id="inv-vehicle"
              value={form.vehicle}
              onChange={set('vehicle')}
              placeholder="Fund I"
            />
          </EventField>
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
            <Button type="submit" disabled={f.pending || companyId === null}>
              {f.pending ? 'Saving…' : 'Record check'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
