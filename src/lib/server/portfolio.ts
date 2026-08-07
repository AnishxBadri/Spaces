import { createServerFn } from '@tanstack/react-start'
import { asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { entity, workspace } from '#/db/schema'
import {
  distribution,
  fxRate,
  holding,
  investment,
  mark,
  round,
  roundCoInvestor,
} from '#/db/schema/portfolio'
import { activity } from '#/db/schema/activity'
import { holdingMetrics } from '../portfolio/metrics'
import type { HoldingEvents, MetricsResult } from '../portfolio/metrics'
import { ownership } from '../portfolio/ownership'
import type { Ownership } from '../portfolio/ownership'
import type { FxRate } from '../portfolio/fx'
import { birthHolding, requireUser } from './shared'

/**
 * The financial engine's server layer (CONTEXT.md phase 15). Events are
 * append-only; every aggregate here is computed at read by the pure lib in
 * src/lib/portfolio/. Base currency lives in workspace.settings.
 */

const num = (s: string | null): number | null => (s === null ? null : Number(s))

async function baseCurrency(): Promise<string> {
  const [ws] = await db.select({ settings: workspace.settings }).from(workspace)
  const base = (ws?.settings as Record<string, unknown> | null)?.base_currency
  return typeof base === 'string' && base.length === 3 ? base : 'USD'
}

async function loadFxRates(): Promise<Array<FxRate>> {
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

type LoadedHolding = {
  events: HoldingEvents
  ownershipInputs: Array<{
    date: string
    amount: number
    instrument: 'priced' | 'safe_post_money' | 'safe_pre_money' | 'ccd'
    shares: number | null
    cap: number | null
  }>
}

async function loadHoldingEvents(
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
  for (const r of investments) {
    const h = byHolding.get(r.holdingId)
    h?.events.investments.push({
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
    })
    h?.ownershipInputs.push({
      date: r.date,
      amount: Number(r.amount),
      instrument: r.instrument,
      shares: num(r.shares),
      cap: num(r.cap),
    })
  }
  for (const r of marks) {
    byHolding.get(r.holdingId)?.events.marks.push({
      date: r.date,
      fairValue: Number(r.fairValue),
      currency: r.currency,
    })
  }
  for (const r of distributions) {
    byHolding.get(r.holdingId)?.events.distributions.push({
      date: r.date,
      amount: Number(r.amount),
      currency: r.currency,
      kind: r.kind,
    })
  }
  return byHolding
}

/**
 * The Portfolio surface's data: per-holding metrics in native-or-base,
 * plus a base-currency roll-up. Holdings missing fx rates surface the gap
 * instead of polluting totals with fake conversions.
 */
export const listHoldings = createServerFn()
  .validator(z.object({ asOf: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    await requireUser()
    const asOf = data?.asOf
    const [base, rates, rows] = await Promise.all([
      baseCurrency(),
      loadFxRates(),
      db
        .select({
          id: holding.id,
          companyId: holding.companyId,
          openedAt: holding.openedAt,
          companyName: entity.canonicalName,
        })
        .from(holding)
        .innerJoin(entity, eq(entity.id, holding.companyId))
        .orderBy(asc(holding.openedAt)),
    ])
    // Rounds power the ownership ledger — one query for every company,
    // fetched alongside the events (independent queries, one round-trip).
    const companyIds = rows.map((r) => r.companyId)
    const [loaded, roundRows] = await Promise.all([
      loadHoldingEvents(rows.map((r) => r.id)),
      companyIds.length > 0
        ? db
            .select({
              companyId: round.companyId,
              date: round.date,
              kind: round.kind,
              sharesOutstanding: round.sharesOutstanding,
            })
            .from(round)
            .where(inArray(round.companyId, companyIds))
            .orderBy(asc(round.date))
        : Promise.resolve([]),
    ])
    const roundsByCompany = new Map<
      string,
      Array<{ date: string; kind: string; sharesOutstanding: number | null }>
    >()
    for (const r of roundRows) {
      const list = roundsByCompany.get(r.companyId) ?? []
      list.push({
        date: r.date,
        kind: r.kind,
        sharesOutstanding: num(r.sharesOutstanding),
      })
      roundsByCompany.set(r.companyId, list)
    }

    const empty: LoadedHolding = {
      events: { investments: [], marks: [], distributions: [] },
      ownershipInputs: [],
    }
    const holdings = rows.map((r) => {
      const l = loaded.get(r.id) ?? empty
      return {
        ...r,
        metrics: holdingMetrics(l.events, {
          baseCurrency: base,
          fxRates: rates,
          asOf,
        }),
        ownership: ownership(
          l.ownershipInputs,
          roundsByCompany.get(r.companyId) ?? [],
          asOf,
        ),
      }
    })

    // Roll-up: everything forced to base; holdings with missing rates are
    // excluded and reported, never silently converted at 1.0. A holding
    // whose display metrics are already base-denominated (the common case:
    // single currency = base) is reused, not recomputed.
    const totals = { costBasis: 0, realized: 0, unrealized: 0 }
    const excluded: Array<string> = []
    for (const [i, r] of rows.entries()) {
      const display = holdings[i].metrics
      const inBase =
        display.ok && display.metrics.currency === base
          ? display
          : holdingMetrics((loaded.get(r.id) ?? empty).events, {
              baseCurrency: base,
              fxRates: rates,
              asOf,
              reportIn: 'base',
            })
      if (!inBase.ok) {
        excluded.push(r.id)
        continue
      }
      totals.costBasis += inBase.metrics.costBasis
      totals.realized += inBase.metrics.realized
      totals.unrealized += inBase.metrics.unrealized
    }
    const totalValue = totals.realized + totals.unrealized
    return {
      baseCurrency: base,
      holdings,
      rollup: {
        ...totals,
        moic: totals.costBasis > 0 ? totalValue / totals.costBasis : null,
        excludedForMissingRates: excluded,
      },
    }
  })

export type HoldingDetail = {
  id: string
  companyId: string
  companyName: string
  openedAt: string
  metrics: MetricsResult
  ownership: Ownership
  rounds: Array<Record<string, unknown>>
  investments: Array<Record<string, unknown>>
  marks: Array<Record<string, unknown>>
  distributions: Array<Record<string, unknown>>
}

/** The tear-sheet read: every event, plus computed metrics and ownership. */
export const getHolding = createServerFn()
  .validator(z.object({ id: z.string().uuid(), asOf: z.string().optional() }))
  .handler(async ({ data }) => {
    await requireUser()
    const [row] = await db
      .select({
        id: holding.id,
        companyId: holding.companyId,
        openedAt: holding.openedAt,
        companyName: entity.canonicalName,
      })
      .from(holding)
      .innerJoin(entity, eq(entity.id, holding.companyId))
      .where(eq(holding.id, data.id))
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

    const events: HoldingEvents = {
      investments: invRows.map((r) => ({
        date: r.date,
        amount: Number(r.amount),
        currency: r.currency,
      })),
      marks: markRows.map((r) => ({
        date: r.date,
        fairValue: Number(r.fairValue),
        currency: r.currency,
      })),
      distributions: distRows.map((r) => ({
        date: r.date,
        amount: Number(r.amount),
        currency: r.currency,
        kind: r.kind,
      })),
    }

    return {
      ...row,
      metrics: holdingMetrics(events, {
        baseCurrency: base,
        fxRates: rates,
        asOf: data.asOf,
      }),
      ownership: ownership(
        invRows.map((r) => ({
          date: r.date,
          amount: Number(r.amount),
          instrument: r.instrument,
          shares: num(r.shares),
          cap: num(r.cap),
        })),
        roundRows.map((r) => ({
          date: r.date,
          kind: r.kind,
          sharesOutstanding: num(r.sharesOutstanding),
        })),
        data.asOf,
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
      investments: invRows.map((r) => ({
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
      })),
      marks: markRows.map((r) => ({
        id: r.id,
        date: r.date,
        fairValue: Number(r.fairValue),
        currency: r.currency,
        basis: r.basis,
      })),
      distributions: distRows.map((r) => ({
        id: r.id,
        date: r.date,
        amount: Number(r.amount),
        currency: r.currency,
        kind: r.kind,
        sharesSold: num(r.sharesSold),
        pricePerShare: num(r.pricePerShare),
      })),
    }
  })

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const ccy = z.string().length(3).toUpperCase()
const money = z.number().finite().nonnegative()

export const createHolding = createServerFn({ method: 'POST' })
  .validator(
    z.object({ companyId: z.string().uuid(), openedAt: isoDate.optional() }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    return birthHolding({
      companyId: data.companyId,
      actorId: u.id,
      openedAt: data.openedAt,
    })
  })

export const addRound = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      companyId: z.string().uuid(),
      date: isoDate,
      kind: z.string().trim().min(1).max(60),
      raised: money.optional(),
      currency: ccy.optional(),
      preMoney: money.optional(),
      postMoney: money.optional(),
      pricePerShare: money.optional(),
      sharesOutstanding: money.optional(),
      coInvestorIds: z.array(z.string().uuid()).max(50).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(round)
        .values({
          companyId: data.companyId,
          date: data.date,
          kind: data.kind,
          raised: data.raised?.toString(),
          currency: data.currency,
          preMoney: data.preMoney?.toString(),
          postMoney: data.postMoney?.toString(),
          pricePerShare: data.pricePerShare?.toString(),
          sharesOutstanding: data.sharesOutstanding?.toString(),
          createdBy: u.id,
        })
        .returning({ id: round.id })
      if (data.coInvestorIds && data.coInvestorIds.length > 0) {
        await tx.insert(roundCoInvestor).values(
          data.coInvestorIds.map((investorEntityId) => ({
            roundId: row.id,
            investorEntityId,
          })),
        )
      }
      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'round.added',
        subjectEntityId: data.companyId,
      })
      return { id: row.id }
    })
  })

export const addInvestment = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      companyId: z.string().uuid(),
      dealId: z.string().uuid().optional(),
      roundId: z.string().uuid().optional(),
      date: isoDate,
      amount: money,
      currency: ccy,
      instrument: z.enum([
        'priced',
        'safe_post_money',
        'safe_pre_money',
        'ccd',
      ]),
      shares: money.optional(),
      cap: money.optional(),
      discount: z.number().finite().min(0).max(1).optional(),
      vehicle: z.string().trim().max(120).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const h = await birthHolding({
      companyId: data.companyId,
      actorId: u.id,
      openedAt: data.date,
    })
    const [row] = await db
      .insert(investment)
      .values({
        holdingId: h.id,
        dealId: data.dealId,
        roundId: data.roundId,
        date: data.date,
        amount: data.amount.toString(),
        currency: data.currency,
        instrument: data.instrument,
        shares: data.shares?.toString(),
        cap: data.cap?.toString(),
        discount: data.discount?.toString(),
        vehicle: data.vehicle,
        createdBy: u.id,
      })
      .returning({ id: investment.id })
    await db.insert(activity).values({
      actorId: u.id,
      verb: 'investment.added',
      subjectEntityId: data.companyId,
    })
    return { id: row.id, holdingId: h.id }
  })

export const addMark = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      holdingId: z.string().uuid(),
      date: isoDate,
      fairValue: money,
      currency: ccy,
      basis: z.enum(['round_price', 'manual', '409a']),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const [h] = await db
      .select({ companyId: holding.companyId })
      .from(holding)
      .where(eq(holding.id, data.holdingId))
    if (!h) throw new Error('Holding not found')
    const [row] = await db
      .insert(mark)
      .values({
        holdingId: data.holdingId,
        date: data.date,
        fairValue: data.fairValue.toString(),
        currency: data.currency,
        basis: data.basis,
        createdBy: u.id,
      })
      .returning({ id: mark.id })
    await db.insert(activity).values({
      actorId: u.id,
      verb: 'mark.added',
      subjectEntityId: h.companyId,
    })
    return { id: row.id }
  })

export const addDistribution = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      holdingId: z.string().uuid(),
      date: isoDate,
      amount: money,
      currency: ccy,
      kind: z.enum(['exit', 'secondary', 'dividend', 'writeoff']),
      sharesSold: money.optional(),
      pricePerShare: money.optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const [h] = await db
      .select({ companyId: holding.companyId })
      .from(holding)
      .where(eq(holding.id, data.holdingId))
    if (!h) throw new Error('Holding not found')
    const [row] = await db
      .insert(distribution)
      .values({
        holdingId: data.holdingId,
        date: data.date,
        amount: data.amount.toString(),
        currency: data.currency,
        kind: data.kind,
        sharesSold: data.sharesSold?.toString(),
        pricePerShare: data.pricePerShare?.toString(),
        createdBy: u.id,
      })
      .returning({ id: distribution.id })
    await db.insert(activity).values({
      actorId: u.id,
      verb:
        data.kind === 'writeoff' ? 'holding.writtenoff' : 'distribution.added',
      subjectEntityId: h.companyId,
    })
    return { id: row.id }
  })

/** Upsert on (currency, date): correcting a rate just recomputes. */
export const setFxRate = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      currency: ccy,
      date: isoDate,
      rateToBase: z.number().positive(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    await db
      .insert(fxRate)
      .values({
        currency: data.currency,
        date: data.date,
        rateToBase: data.rateToBase.toString(),
        createdBy: u.id,
      })
      .onConflictDoUpdate({
        target: [fxRate.currency, fxRate.date],
        set: { rateToBase: data.rateToBase.toString() },
      })
    return { ok: true }
  })

export const listFxRates = createServerFn().handler(async () => {
  await requireUser()
  const [base, rates] = await Promise.all([baseCurrency(), loadFxRates()])
  return { baseCurrency: base, rates }
})
