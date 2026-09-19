import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsRow,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { setBaseCurrency, setFxRate } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

const shell = getRouteApi('/_app/settings')

/** The base currency and the manual FX rate ledger. */
export const Route = createFileRoute('/_app/settings/currency')({
  component: CurrencyRoute,
})

function CurrencyRoute() {
  const data = shell.useLoaderData()
  return (
    <FxSection
      isAdmin={data.isAdmin}
      baseCurrency={data.fx.baseCurrency}
      rates={data.fx.rates}
    />
  )
}

/**
 * FX rates — the manual rate table behind portfolio currency conversion
 * (CONTEXT.md, 2026-08-06). Sparse on purpose: a rate per (currency, date)
 * when a non-base event needs one; upserting a correction just recomputes.
 */
function FxSection({
  isAdmin,
  baseCurrency,
  rates,
}: {
  isAdmin: boolean
  baseCurrency: string
  rates: Array<{ currency: string; date: string; rateToBase: number }>
}) {
  const router = useRouter()
  const [base, setBase] = useState(baseCurrency)
  const [form, setForm] = useState({ currency: '', date: '', rate: '' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function saveBase() {
    if (base.trim().toUpperCase() === baseCurrency) return
    setPending(true)
    setError(null)
    try {
      await setBaseCurrency({ data: { currency: base.trim().toUpperCase() } })
      toast('Base currency saved')
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setPending(false)
    }
  }

  async function addRate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const rate = Number(form.rate)
    if (!form.currency.trim() || !form.date || !(rate > 0)) {
      setError('Currency, date, and a positive rate — all three.')
      return
    }
    setPending(true)
    setError(null)
    try {
      await setFxRate({
        data: {
          currency: form.currency.trim().toUpperCase(),
          date: form.date,
          rateToBase: rate,
        },
      })
      toast('Rate saved')
      setForm({ currency: '', date: '', rate: '' })
      void router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the rate')
    } finally {
      setPending(false)
    }
  }

  const sorted = [...rates].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) || b.date.localeCompare(a.date),
  )
  // Newest per currency is the live rate; older ones are kept for the
  // events dated before it (rates are append-only, a new date supersedes).
  const newest = new Set<string>()
  for (const r of sorted) {
    if (!newest.has(r.currency)) newest.add(`${r.currency}:${r.date}`)
    newest.add(r.currency)
  }
  const isLive = (r: { currency: string; date: string }) =>
    newest.has(`${r.currency}:${r.date}`)
  const currencies = new Set(rates.map((r) => r.currency)).size

  return (
    <SettingsSection
      title="Currency & FX rates"
      blurb="Every holding is priced in the base currency. Rates are entered by hand and dated; a missing rate leaves the holding unpriced, never guessed."
      crumb="Capital"
    >
      <SettingsRow
        label="Base currency"
        hint="Changing it re-prices the portfolio strip; ledgers keep their original currency."
      >
        <Input
          id="fx-base"
          aria-label="Base currency"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          maxLength={3}
          className="w-24 mono uppercase"
          disabled={!isAdmin}
        />
        {isAdmin && base.trim().toUpperCase() !== baseCurrency ? (
          <Button size="sm" onClick={saveBase} disabled={pending}>
            Save
          </Button>
        ) : null}
      </SettingsRow>

      <div className="flex flex-col pt-5">
        <div className="flex items-baseline justify-between pb-2">
          <div className="flex items-baseline gap-3">
            <h3 className="label-caps text-foreground">Rates</h3>
            <span className="mono text-micro text-graphite">
              {rates.length} · sparse, dated, newest wins
            </span>
          </div>
        </div>

        {/* The ledger head. */}
        <div className="flex h-8 items-center border-y border-hairline field-label leading-4 text-graphite">
          <span className="w-35 shrink-0">Pair</span>
          <span className="w-40 shrink-0 pr-4 text-right">Rate</span>
          <span className="w-35 shrink-0">As of</span>
          <span className="min-w-0 flex-1">Used for</span>
        </div>
        {sorted.map((r) => {
          const live = isLive(r)
          return (
            <div
              key={`${r.currency}:${r.date}`}
              className={cn(
                'flex h-9 items-center border-b border-rule',
                live ? 'text-foreground' : 'text-graphite',
              )}
            >
              <span className="w-35 shrink-0 mono text-ui">
                {r.currency} → {baseCurrency}
              </span>
              <span className="w-40 shrink-0 pr-4 numeric text-ui">
                {r.rateToBase}
              </span>
              <span className="w-35 shrink-0 mono text-label">{r.date}</span>
              <span className="min-w-0 flex-1 truncate mono text-micro text-graphite">
                {live
                  ? `events on or after ${r.date}`
                  : `superseded · kept for events before the newer rate`}
              </span>
            </div>
          )
        })}

        {/* The composer row: a rate is appended, never edited. */}
        <form
          onSubmit={addRate}
          className="flex min-h-9 flex-wrap items-center gap-2 border-b border-rule py-1"
        >
          <span className="mono text-micro text-primary">+</span>
          <Input
            id="fx-ccy"
            aria-label="Currency"
            value={form.currency}
            onChange={(e) =>
              setForm((s) => ({ ...s, currency: e.target.value }))
            }
            placeholder="EUR"
            maxLength={3}
            className="h-7 w-20 mono uppercase"
          />
          <span className="mono text-micro text-graphite">
            → {baseCurrency}
          </span>
          <Input
            id="fx-rate"
            aria-label={`1 unit in ${baseCurrency}`}
            type="number"
            step="any"
            min="0"
            value={form.rate}
            onChange={(e) => setForm((s) => ({ ...s, rate: e.target.value }))}
            placeholder="1.0900"
            className="h-7 w-28 mono"
          />
          <Input
            id="fx-date"
            aria-label="As of"
            type="date"
            value={form.date}
            onChange={(e) => setForm((s) => ({ ...s, date: e.target.value }))}
            className="h-7 w-40 mono"
          />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Add rate
          </Button>
          {error ? (
            <span role="alert" className="mono text-micro text-destructive">
              {error}
            </span>
          ) : null}
        </form>

        <div className="flex h-8 items-center justify-between">
          <span className="label-caps font-normal text-graphite">
            {rates.length} rate{rates.length === 1 ? '' : 's'} · {currencies}{' '}
            currenc{currencies === 1 ? 'y' : 'ies'}
          </span>
          <span className="mono text-micro text-graphite">
            rates are append-only · a new date supersedes, nothing edits
          </span>
        </div>
      </div>
    </SettingsSection>
  )
}
