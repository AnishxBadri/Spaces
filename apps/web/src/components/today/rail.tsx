import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { MetricsResult } from '@spaces/core/portfolio/metrics'
import type { PortfolioRollup } from '@spaces/core/portfolio/rollup'
import { LabelHead } from '#/components/ledger-section'
import { PortfolioHeadlineRail } from '#/components/portfolio-headline'
import type { MovingSignal } from '#/lib/server-fns'
import { daysBetween } from '#/lib/today/needs-you'

/** The rail's time lane, date-only so server and client agree. */
function whenLabel(atIso: string, today: string): string {
  const d = daysBetween(atIso, today)
  if (d === 0) return 'today'
  if (d === 1) return 'yest'
  return atIso.slice(5, 10)
}

/** A citation's printed form: the host, without `www.`. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** A rail section's head: a mono caps label on a hairline, its meta right. */
function RailHead({ label, meta }: { label: string; meta: string }) {
  return (
    <LabelHead label={label} className="px-0">
      <span className="shrink-0 mono text-micro text-graphite">{meta}</span>
    </LabelHead>
  )
}

/**
 * The currencies an unpriced holding is waiting on: its own currency when it
 * reports in one, else the rates its metrics named missing. Sorted, unique.
 */
export function unpricedCurrencies(
  holdings: ReadonlyArray<{ id: string; metrics: MetricsResult }>,
  excluded: ReadonlyArray<string>,
): Array<string> {
  const out = new Set<string>()
  for (const h of holdings) {
    if (!excluded.includes(h.id)) continue
    if (h.metrics.ok) out.add(h.metrics.metrics.currency)
    else for (const r of h.metrics.missingRates) out.add(r.currency)
  }
  return [...out].sort()
}

/**
 * The book in the rail: Invested, Value, MOIC, then the holdings left out
 * for a missing rate with the rate to add.
 */
export function PortfolioRail({
  rollup,
  baseCurrency,
  holdingCount,
  missing,
}: {
  rollup: PortfolioRollup
  baseCurrency: string
  holdingCount: number
  /** Currencies with no rate to the base; see `unpricedCurrencies`. */
  missing: ReadonlyArray<string>
}) {
  const unpriced = rollup.excludedForMissingRates.length
  return (
    <section className="flex flex-col gap-3 border-b border-hairline px-6 pt-3 pb-5">
      <RailHead
        label="Portfolio"
        meta={`${baseCurrency} · ${holdingCount} holding${holdingCount === 1 ? '' : 's'}`}
      />
      <PortfolioHeadlineRail rollup={rollup} baseCurrency={baseCurrency} />
      {unpriced > 0 ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="field-label text-warning">
            {unpriced} holding{unpriced === 1 ? '' : 's'} unpriced
          </span>
          <Link
            to="/settings/currency"
            className="focus-ring shrink-0 mono text-micro text-primary hover:underline"
          >
            {missing.length === 1
              ? `add ${missing[0]}→${baseCurrency} ›`
              : 'add FX rates ›'}
          </Link>
        </div>
      ) : (
        <div className="flex justify-end">
          <Link
            to="/portfolio"
            className="focus-ring mono text-micro text-foreground hover:underline"
          >
            portfolio ›
          </Link>
        </div>
      )}
    </section>
  )
}

/**
 * What's moving: signals from the last seven days on the reader's companies,
 * newest first, each citing where it was read. Always drawn; a quiet week
 * is one line.
 */
export function WhatsMoving({
  signals,
  today,
}: {
  signals: ReadonlyArray<MovingSignal>
  today: string
}) {
  return (
    <section
      aria-label="What's moving"
      className="flex flex-col border-b border-hairline px-6 pt-3 pb-5"
    >
      <RailHead label="What's moving" meta="your companies · 7d" />
      {signals.length === 0 ? (
        <p data-moving-empty className="pt-3 text-ui text-graphite">
          Nothing new in 7 days.
        </p>
      ) : (
        <ol>
          {signals.map((s) => {
            const host = s.url === null ? null : hostOf(s.url)
            return (
              <li
                key={s.id}
                className="flex items-start gap-2.5 border-b border-rule py-2 last:border-b-0"
              >
                <span className="w-10 shrink-0 pt-0.5 mono text-micro text-graphite">
                  {whenLabel(s.observedAt, today)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <Link
                    to="/companies/$companyId"
                    params={{ companyId: s.companyId }}
                    className="focus-ring truncate text-ui text-foreground hover:underline"
                  >
                    {s.title ?? s.kind ?? 'Signal'}
                  </Link>
                  <span className="flex min-w-0 items-baseline gap-1 mono text-micro text-graphite">
                    <span className="min-w-0 truncate">
                      {s.companyName} · via {s.source}
                    </span>
                    {s.url !== null && host !== null ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="focus-ring max-w-28 shrink-0 truncate hover:text-foreground"
                      >
                        · {host}
                      </a>
                    ) : null}
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

export type TeamEntry = {
  id: string
  verb: string
  at: string
  actorName: string
  subjectName: string | null
}

/** Two-letter type code for a ledger entry, from the verb's subject. */
function verbCode(verb: string): string {
  const [subject, action] = verb.split('.')
  const CODES: Record<string, string> = {
    mark: 'MK',
    investment: 'IN',
    round: 'RD',
    holding: 'HL',
    deal: 'DL',
    company: 'CO',
    person: 'PE',
    note: 'NT',
    document: 'FI',
    space: 'SP',
    term: 'TM',
    mandate: 'MD',
    task: 'TK',
    interaction: 'IX',
    signal: 'SG',
  }
  return CODES[subject] ?? (action ? subject : verb).slice(0, 2).toUpperCase()
}

/**
 * The team's last 24 hours, folded behind "team activity ›" and opened in
 * place. Renders nothing when nobody did anything.
 */
export function TeamActivity({
  entries,
  today,
}: {
  entries: ReadonlyArray<TeamEntry>
  today: string
}) {
  const [open, setOpen] = useState(false)
  if (entries.length === 0) return null
  return (
    <section className="flex flex-col px-6 py-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring flex items-baseline justify-between text-left mono text-micro text-graphite hover:text-foreground"
      >
        <span>team activity {open ? '‹' : '›'}</span>
        <span>{entries.length} · 24h</span>
      </button>
      {open ? (
        <ol className="pt-2.5">
          {entries.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-3 border-t border-rule py-2"
            >
              <span className="w-11 shrink-0 mono text-micro text-graphite">
                {whenLabel(a.at, today)}
              </span>
              <span className="w-5 shrink-0 mono text-field font-medium">
                {verbCode(a.verb)}
              </span>
              <span className="min-w-0 text-label leading-4.25">
                <span className="font-medium">{a.actorName}</span>{' '}
                {a.verb.replace(/[._]/g, ' ')}
                {a.subjectName ? ` · ${a.subjectName}` : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
