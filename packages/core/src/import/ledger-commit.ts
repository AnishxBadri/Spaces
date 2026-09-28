import { rateFor } from '../portfolio/fx'
import { moneyText } from './ledger'
import type { FxRate } from '../portfolio/fx'
import type {
  LedgerCommitted,
  LedgerEventKind,
  LedgerRowPlan,
} from '@spaces/db/schema/import'

/**
 * **Ledger commit** (SPA-171, project 14 `import-9`) — the rules the ledger
 * commit's receipt decides without a query. The database half — each row's
 * holding and events through the portfolio write path, in the row's own
 * transaction — is `apps/web/src/lib/import/ledger-commit.ts`; here is what
 * the outcome lane says a committed row appended, which events still want an
 * FX rate, and the receipt's two commentary lines.
 */

export type { LedgerCommitted, LedgerEventKind }

/**
 * What one committed row appended, in the order the lane prints it:
 * `holding born · round Seed · investment $50,000 · mark $120,000`. An event
 * the commit matched to an existing live row, rather than appended, says so.
 */
export function ledgerOutcomeParts(plan: LedgerRowPlan): Array<string> {
  const committed = plan.ledger.committed
  const events = plan.ledger.events
  if (!committed || !events) return []
  const reused = new Set(committed.reused ?? [])
  const tag = (kind: LedgerEventKind, text: string) =>
    reused.has(kind) ? `${text} (existing)` : text
  const out: Array<string> = []
  if (committed.holdingBorn) out.push('holding born')
  const r = events.round
  if (r && committed.roundId !== undefined)
    out.push(tag('round', `round ${r.kind}`))
  const i = events.investment
  out.push(tag('investment', `investment ${moneyText(i.amount, i.currency)}`))
  const m = events.mark
  if (m && committed.markId !== undefined)
    out.push(tag('mark', `mark ${moneyText(m.fairValue, m.currency)}`))
  const d = events.distribution
  if (d && committed.distributionId !== undefined)
    out.push(
      tag(
        'distribution',
        `${d.kind === 'writeoff' ? 'write-off' : d.kind} ${moneyText(d.amount, d.currency)}`,
      ),
    )
  return out
}

// ---------------------------------------------------------------------------
// Missing FX rates
// ---------------------------------------------------------------------------

/** One currency the committed events need a rate for. */
export type MissingRate = {
  currency: string
  /** Events in that currency with no rate on or before their date. */
  events: number
  /** The earliest of their dates — a rate on or before it covers them all. */
  earliest: string
}

/**
 * The committed events a base-currency roll-up cannot price: a currency
 * other than base with no `fx_rate` on or before the event's date — the
 * lookup `/today` and `/portfolio` make (`rateFor`), never 1.0 — grouped by
 * currency, most events first.
 */
export function missingRates(
  events: ReadonlyArray<{ currency: string; date: string; n: number }>,
  rates: Array<FxRate>,
  baseCurrency: string,
): Array<MissingRate> {
  const by = new Map<string, MissingRate>()
  for (const e of events) {
    if (rateFor(rates, e.currency, e.date, baseCurrency) !== null) continue
    const held = by.get(e.currency)
    if (!held) {
      by.set(e.currency, {
        currency: e.currency,
        events: e.n,
        earliest: e.date,
      })
      continue
    }
    held.events += e.n
    if (e.date < held.earliest) held.earliest = e.date
  }
  return [...by.values()].sort(
    (a, b) => b.events - a.events || a.currency.localeCompare(b.currency),
  )
}

/** Letters whose spoken name opens on a vowel: an INR, an AED, a USD. */
const AN = new Set(['A', 'E', 'F', 'H', 'I', 'L', 'M', 'N', 'O', 'R', 'S', 'X'])

/**
 * The receipt's missing-rate line: `6 events need an INR rate on or before
 * 2023-03-15 · 2 events need a JPY rate on or before 2024-02-01`.
 */
export function missingRateLine(missing: ReadonlyArray<MissingRate>): string {
  return missing
    .map((m) => {
      const article = AN.has(m.currency.charAt(0)) ? 'an' : 'a'
      const n = m.events.toLocaleString('en-US')
      const verb = m.events === 1 ? 'event needs' : 'events need'
      return `${n} ${verb} ${article} ${m.currency} rate on or before ${m.earliest}`
    })
    .join(' · ')
}

// ---------------------------------------------------------------------------
// The void note
// ---------------------------------------------------------------------------

/** What a batch void reaches, and what it leaves. */
export type LedgerVoidState = {
  /** Live investments, marks and distributions stamped with the batch id. */
  investments: number
  marks: number
  distributions: number
  /** Of those, how many a compensating event already cites. */
  voided: number
  /** Rounds this batch created — never stamped, never voided (D12). */
  rounds: number
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * The receipt's one line about voiding, as counts: what a batch void
 * reaches — `void reaches 11 investments · 7 marks · 8 rounds stay` — or,
 * once voided, what it reversed. Null when the batch appended nothing to
 * void. What a void does is said on its confirm, not here.
 */
export function ledgerVoidLine(v: LedgerVoidState): string | null {
  const total = v.investments + v.marks + v.distributions
  if (total === 0) return null
  const parts = [
    ...(v.investments > 0 ? [count(v.investments, 'investment')] : []),
    ...(v.marks > 0 ? [count(v.marks, 'mark')] : []),
    ...(v.distributions > 0 ? [count(v.distributions, 'distribution')] : []),
  ]
  const rounds =
    v.rounds === 0
      ? []
      : [`${count(v.rounds, 'round')} ${v.rounds === 1 ? 'stays' : 'stay'}`]
  if (v.voided >= total)
    return ['voided', `${parts.join(' · ')} reversed`, ...rounds].join(' · ')
  return `void reaches ${[...parts, ...rounds].join(' · ')}`
}
