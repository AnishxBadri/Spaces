import { asc, eq, inArray } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity, workspace } from '@spaces/db/schema'
import {
  distribution,
  fxRate,
  holding,
  investment,
  mark,
  round,
} from '@spaces/db/schema/portfolio'
import { user } from '@spaces/db/schema/auth'
import { holdingMetrics } from '@spaces/core/portfolio/metrics'
import type { HoldingEvents } from '@spaces/core/portfolio/metrics'
import { ownership } from '@spaces/core/portfolio/ownership'
import type { FxRate } from '@spaces/core/portfolio/fx'

/**
 * The portfolio read layer — the loader the server fns call once they have a
 * user. It lives here rather than in `server/portfolio.ts` because that
 * module is re-exported wholesale by the client-imported `server-fns.ts`
 * barrel, which may carry server fns and types and nothing else.
 *
 * **Reader contract for reversals (D12, SPA-150).** A void appends a
 * compensating row citing the original; the pure libs never see that row.
 * `partitionReversals` keeps the originals and stamps each with
 * `reversedAt` — the reversal's `created_at`, which is the void instant —
 * and `holdingMetrics`/`ownership` drop an event once the as-of day has
 * reached it, so an as-of date before the void still sees the original.
 *
 * Nothing derived leans on the negation cancelling, because nothing derived
 * is a plain sum: `holdingMetrics` picks the *latest* mark, `writtenOff`
 * reads the latest write-off distribution, and `ownership()` filters
 * `shares > 0`. The negation is stored so a raw SQL `SUM` over the table
 * stays honest and the timeline can show the correction.
 */

export const num = (s: string | null): number | null =>
  s === null ? null : Number(s)

export async function baseCurrency(): Promise<string> {
  const ws = (
    await db.select({ settings: workspace.settings }).from(workspace)
  ).at(0)
  const base = ws?.settings.base_currency
  return base !== undefined && base.length === 3 ? base : 'USD'
}

export async function loadFxRates(): Promise<Array<FxRate>> {
  const rows = await db
    .select({
      currency: fxRate.currency,
      date: fxRate.date,
      rateToBase: fxRate.rateToBase,
    })
    .from(fxRate)
  return rows.map((r) => ({
    currency: r.currency,
    date: r.date,
    rateToBase: Number(r.rateToBase),
  }))
}

/**
 * One table's rows split into what the pure libs read and what the timeline
 * shows beneath it. A compensating row is recognized by `reverses_id`.
 */
export function partitionReversals<
  T extends { id: string; reversesId: string | null; createdAt: Date },
>(rows: Array<T>): { originals: Array<T>; reversalOf: Map<string, T> } {
  const reversalOf = new Map<string, T>()
  const originals: Array<T> = []
  for (const r of rows) {
    if (r.reversesId === null) originals.push(r)
    else reversalOf.set(r.reversesId, r)
  }
  return { originals, reversalOf }
}

/** The void instant the pure libs gate on, or null while the event stands. */
export function reversedAtOf(
  reversalOf: Map<string, { createdAt: Date }>,
  id: string,
): string | null {
  return reversalOf.get(id)?.createdAt.toISOString() ?? null
}

/**
 * The ledger the detail view renders: every original in date order with its
 * compensating row immediately beneath it, so "struck, and here is why"
 * needs no client-side pairing. `reversedAt` marks an original as struck;
 * `reversesId` marks the row that struck it, and it carries the voider's
 * name and the day the void was written.
 */
export type ReversalMarks = {
  /** Non-null on the compensating row: the id of the entry it voids. */
  reversesId: string | null
  /** Non-null on a struck original: the instant it was voided. */
  reversedAt: string | null
  voidedBy: string | null
  voidedOn: string | null
}

export function withReversalsBeneath<
  T extends {
    id: string
    reversesId: string | null
    createdAt: Date
    createdBy: string | null
  },
  TShape,
>(
  part: { originals: Array<T>; reversalOf: Map<string, T> },
  voidedBy: (createdBy: string | null) => string | null,
  shape: (row: T) => TShape,
): Array<TShape & ReversalMarks> {
  return part.originals.flatMap((r) => {
    const reversal = part.reversalOf.get(r.id)
    const original = {
      ...shape(r),
      reversesId: null,
      reversedAt: reversal?.createdAt.toISOString() ?? null,
      voidedBy: null,
      voidedOn: null,
    }
    if (reversal === undefined) return [original]
    return [
      original,
      {
        ...shape(reversal),
        reversesId: r.id,
        reversedAt: null,
        voidedBy: voidedBy(reversal.createdBy),
        voidedOn: reversal.createdAt.toISOString().slice(0, 10),
      },
    ]
  })
}

export type LoadedHolding = {
  events: HoldingEvents
  ownershipInputs: Array<{
    date: string
    amount: number
    instrument: 'priced' | 'safe_post_money' | 'safe_pre_money' | 'ccd'
    shares: number | null
    cap: number | null
    reversedAt: string | null
  }>
}

export async function loadHoldingEvents(
  holdingIds: Array<string>,
): Promise<Map<string, LoadedHolding>> {
  const byHolding = new Map<string, LoadedHolding>()
  for (const id of holdingIds) {
    byHolding.set(id, {
      events: { investments: [], marks: [], distributions: [] },
      ownershipInputs: [],
    })
  }
  if (holdingIds.length === 0) return byHolding
  const [investments, marks, distributions] = await Promise.all([
    db
      .select()
      .from(investment)
      .where(inArray(investment.holdingId, holdingIds))
      .orderBy(asc(investment.date)),
    db
      .select()
      .from(mark)
      .where(inArray(mark.holdingId, holdingIds))
      .orderBy(asc(mark.date)),
    db
      .select()
      .from(distribution)
      .where(inArray(distribution.holdingId, holdingIds))
      .orderBy(asc(distribution.date)),
  ])
  const inv = partitionReversals(investments)
  const mk = partitionReversals(marks)
  const dist = partitionReversals(distributions)
  for (const r of inv.originals) {
    const h = byHolding.get(r.holdingId)
    const reversedAt = reversedAtOf(inv.reversalOf, r.id)
    h?.events.investments.push({
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
      reversedAt,
    })
    h?.ownershipInputs.push({
      date: r.date,
      amount: Number(r.amount),
      instrument: r.instrument,
      shares: num(r.shares),
      cap: num(r.cap),
      reversedAt,
    })
  }
  for (const r of mk.originals) {
    byHolding.get(r.holdingId)?.events.marks.push({
      date: r.date,
      fairValue: Number(r.fairValue),
      currency: r.currency,
      reversedAt: reversedAtOf(mk.reversalOf, r.id),
    })
  }
  for (const r of dist.originals) {
    byHolding.get(r.holdingId)?.events.distributions.push({
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
      kind: r.kind,
      reversedAt: reversedAtOf(dist.reversalOf, r.id),
    })
  }
  return byHolding
}

/** The tear-sheet read: every event, plus computed metrics and ownership. */
export async function loadHoldingDetail(id: string, asOf?: string) {
  const row = (
    await db
      .select({
        id: holding.id,
        companyId: holding.companyId,
        openedAt: holding.openedAt,
        companyName: entity.canonicalName,
      })
      .from(holding)
      .innerJoin(entity, eq(entity.id, holding.companyId))
      .where(eq(holding.id, id))
  ).at(0)
  if (!row) throw new Error('Holding not found')

  const [base, rates, invRows, markRows, distRows, roundRows] =
    await Promise.all([
      baseCurrency(),
      loadFxRates(),
      db
        .select()
        .from(investment)
        .where(eq(investment.holdingId, row.id))
        .orderBy(asc(investment.date)),
      db
        .select()
        .from(mark)
        .where(eq(mark.holdingId, row.id))
        .orderBy(asc(mark.date)),
      db
        .select()
        .from(distribution)
        .where(eq(distribution.holdingId, row.id))
        .orderBy(asc(distribution.date)),
      db
        .select()
        .from(round)
        .where(eq(round.companyId, row.companyId))
        .orderBy(asc(round.date)),
    ])

  const inv = partitionReversals(invRows)
  const mk = partitionReversals(markRows)
  const dist = partitionReversals(distRows)

  // The voiders, named once: the timeline says who struck each entry.
  const voiderIds = [
    ...new Set(
      [...inv.reversalOf, ...mk.reversalOf, ...dist.reversalOf].flatMap(
        ([, r]) => (r.createdBy === null ? [] : [r.createdBy]),
      ),
    ),
  ]
  const voiderRows =
    voiderIds.length > 0
      ? await db
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, voiderIds))
      : []
  const voiders = new Map(voiderRows.map((u) => [u.id, u.name]))
  const voidedBy = (createdBy: string | null): string | null =>
    createdBy === null ? null : (voiders.get(createdBy) ?? null)

  const events: HoldingEvents = {
    investments: inv.originals.map((r) => ({
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
      reversedAt: reversedAtOf(inv.reversalOf, r.id),
    })),
    marks: mk.originals.map((r) => ({
      date: r.date,
      fairValue: Number(r.fairValue),
      currency: r.currency,
      reversedAt: reversedAtOf(mk.reversalOf, r.id),
    })),
    distributions: dist.originals.map((r) => ({
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
      kind: r.kind,
      reversedAt: reversedAtOf(dist.reversalOf, r.id),
    })),
  }

  return {
    ...row,
    metrics: holdingMetrics(events, {
      baseCurrency: base,
      fxRates: rates,
      asOf: asOf,
    }),
    ownership: ownership(
      inv.originals.map((r) => ({
        date: r.date,
        amount: Number(r.amount),
        instrument: r.instrument,
        shares: num(r.shares),
        cap: num(r.cap),
        reversedAt: reversedAtOf(inv.reversalOf, r.id),
      })),
      roundRows.map((r) => ({
        date: r.date,
        kind: r.kind,
        sharesOutstanding: num(r.sharesOutstanding),
      })),
      asOf,
    ),
    rounds: roundRows.map((r) => ({
      id: r.id,
      date: r.date,
      kind: r.kind,
      raised: num(r.raised),
      currency: r.currency,
      preMoney: num(r.preMoney),
      postMoney: num(r.postMoney),
      pricePerShare: num(r.pricePerShare),
      sharesOutstanding: num(r.sharesOutstanding),
    })),
    investments: withReversalsBeneath(inv, voidedBy, (r) => ({
      id: r.id,
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
      instrument: r.instrument,
      shares: num(r.shares),
      cap: num(r.cap),
      discount: num(r.discount),
      vehicle: r.vehicle,
      dealId: r.dealId,
      roundId: r.roundId,
      batchId: r.batchId,
    })),
    marks: withReversalsBeneath(mk, voidedBy, (r) => ({
      id: r.id,
      date: r.date,
      fairValue: Number(r.fairValue),
      currency: r.currency,
      basis: r.basis,
      batchId: r.batchId,
    })),
    distributions: withReversalsBeneath(dist, voidedBy, (r) => ({
      id: r.id,
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
      kind: r.kind,
      sharesSold: num(r.sharesSold),
      pricePerShare: num(r.pricePerShare),
      batchId: r.batchId,
    })),
  }
}
