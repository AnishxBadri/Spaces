import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  SettingsGroupHead,
  SettingsSection,
} from '#/components/settings/settings-section'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { fmtRate, fxLedgerRows } from '#/lib/fx-ledger'
import { setFxRate } from '#/lib/server-fns'
import { formatDay } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { cn } from '#/lib/utils'

const shell = getRouteApi('/_app/settings')

/** The manual FX rate ledger. The base currency is set in General. */
export const Route = createFileRoute('/_app/settings/currency')({
  component: CurrencyRoute,
})

function CurrencyRoute() {
  const data = shell.useLoaderData()
  return <FxSection baseCurrency={data.fx.baseCurrency} rates={data.fx.rates} />
}

/**
 * FX rates — the manual rate table behind portfolio currency conversion.
 * - A rate is appended per (currency, date); a correction upserts and every
 *   derived number recomputes.
 * - Each row prints the events it covers: the live rate from its date on, a
 *   superseded one its own range (`fxLedgerRows`).
 */
function FxSection({
  baseCurrency,
  rates,
}: {
  baseCurrency: string
  rates: Array<{ currency: string; date: string; rateToBase: number }>
}) {
  const router = useRouter()
  const { today } = useClock()
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

  const rows = fxLedgerRows(rates, today)
  const currencies = new Set(rates.map((r) => r.currency)).size

  return (
    <SettingsSection title="Currency & FX" crumb="Workspace">
      <div className="flex flex-col">
        <SettingsGroupHead
          title="Rates"
          count={`${rates.length} · ${currencies} ${currencies === 1 ? 'currency' : 'currencies'}`}
        />

        <div className="flex h-8 items-center border-b border-hairline field-label leading-4 text-graphite">
          <span className="min-w-0 flex-1">Pair</span>
          <span className="w-28 shrink-0 pr-3 text-right">Rate</span>
          <span className="w-28 shrink-0">From</span>
          <span className="w-44 shrink-0">Applies to</span>
        </div>
        {rows.map((r) => (
          <div
            key={`${r.currency}:${r.date}`}
            data-fx-row
            className={cn(
              'flex h-10 items-center border-b border-rule',
              r.live ? 'text-foreground' : 'text-graphite',
            )}
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-ui',
                r.live && 'font-medium',
              )}
            >
              {r.currency} → {baseCurrency}
            </span>
            <span className="w-28 shrink-0 pr-3 numeric text-right text-label">
              {fmtRate(r.rateToBase)}
            </span>
            <span className="w-28 shrink-0 mono text-micro text-graphite">
              {formatDay(r.date, today)}
            </span>
            <span className="w-44 shrink-0 truncate text-label">
              {r.appliesTo}
            </span>
          </div>
        ))}

        {/* The composer row: a rate is appended, never edited. */}
        <form
          onSubmit={addRate}
          className="flex min-h-12 flex-wrap items-center gap-2 border-b border-rule py-2"
        >
          <Input
            id="fx-ccy"
            aria-label="Currency"
            value={form.currency}
            onChange={(e) =>
              setForm((s) => ({ ...s, currency: e.target.value }))
            }
            placeholder="EUR"
            maxLength={3}
            className="w-18 mono uppercase"
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
            className="w-24 mono"
          />
          <Input
            id="fx-date"
            aria-label="As of"
            type="date"
            value={form.date}
            onChange={(e) => setForm((s) => ({ ...s, date: e.target.value }))}
            className="w-36 mono"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={pending}
            className="ml-auto"
          >
            Add rate
          </Button>
          {error ? (
            <span
              role="alert"
              className="basis-full mono text-micro text-destructive"
            >
              {error}
            </span>
          ) : null}
        </form>
      </div>
    </SettingsSection>
  )
}
