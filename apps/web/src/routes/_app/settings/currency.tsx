import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { SettingsSection } from '#/components/settings/settings-section'
import { SectionHead } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { setFxRate } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

const shell = getRouteApi('/_app/settings')

/** The manual FX rate ledger. The base currency is set in General. (D81) */
export const Route = createFileRoute('/_app/settings/currency')({
  component: CurrencyRoute,
})

function CurrencyRoute() {
  const data = shell.useLoaderData()
  return <FxSection baseCurrency={data.fx.baseCurrency} rates={data.fx.rates} />
}

/**
 * FX rates — the manual rate table behind portfolio currency conversion
 * (CONTEXT.md, 2026-08-06). Sparse on purpose: a rate per (currency, date)
 * when a non-base event needs one; upserting a correction just recomputes.
 */
function FxSection({
  baseCurrency,
  rates,
}: {
  baseCurrency: string
  rates: Array<{ currency: string; date: string; rateToBase: number }>
}) {
  const router = useRouter()
  const [form, setForm] = useState({ currency: '', date: '', rate: '' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

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
      blurb="Every holding is priced in the base currency; a missing rate leaves it unpriced."
      crumb="Workspace"
    >
      <div className="flex flex-col pt-8">
        <SectionHead
          as="h3"
          title="Rates"
          count={`${rates.length} · sparse, dated, newest wins`}
        />

        {/* The ledger head. */}
        <div className="flex h-8 items-center border-b border-hairline px-3 field-label leading-4 text-graphite">
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
                'flex h-9 items-center border-b border-rule px-3',
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
          className="flex min-h-9 flex-wrap items-center gap-2 border-b border-rule px-3 py-1"
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

        <div className="flex h-8 items-center justify-between px-3">
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
