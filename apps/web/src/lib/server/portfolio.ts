import { createServerFn } from '@tanstack/react-start'
import { asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { entity, workspace } from '@spaces/db/schema'
import {
  distribution,
  fxRate,
  holding,
  investment,
  mark,
  round,
  roundCoInvestor,
} from '@spaces/db/schema/portfolio'
import { activity } from '@spaces/db/schema/activity'
import { holdingMetrics } from '@spaces/core/portfolio/metrics'
import type { MetricsResult } from '@spaces/core/portfolio/metrics'
import { ownership } from '@spaces/core/portfolio/ownership'
import type { Ownership } from '@spaces/core/portfolio/ownership'
import {
  baseCurrency,
  loadFxRates,
  loadHoldingEvents,
  num,
} from '../portfolio/detail'
import type { LoadedHolding } from '../portfolio/detail'
import { birthHolding, requireUser } from './shared'

/**
 * The financial engine's server layer (CONTEXT.md phase 15). Events are
 * append-only; every aggregate here is computed at read by the pure lib in
 * packages/core/src/portfolio/. Base currency lives in workspace.settings.
 *
 * The read itself is `../portfolio/detail`, which is where the reversal
 * reader contract (D12, SPA-150) is stated: the pure libs are handed
 * originals only, each stamped with `reversedAt`. These handlers are the
 * auth gate and the write paths.
 */

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
/** The tear-sheet read: every event, plus computed metrics and ownership. */
export const getHolding = createServerFn()
  .validator(z.object({ id: z.string().uuid(), asOf: z.string().optional() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { loadHoldingDetail } = await import('../portfolio/detail')
    return loadHoldingDetail(data.id, data.asOf)
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
    const h = (
      await db
        .select({ companyId: holding.companyId })
        .from(holding)
        .where(eq(holding.id, data.holdingId))
    ).at(0)
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
    const h = (
      await db
        .select({ companyId: holding.companyId })
        .from(holding)
        .where(eq(holding.id, data.holdingId))
    ).at(0)
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

/**
 * Base currency is a workspace-settings key, admin-only: changing it
 * re-denominates every roll-up at next read (nothing stored converts).
 */
export const setBaseCurrency = createServerFn({ method: 'POST' })
  .validator(z.object({ currency: ccy }))
  .handler(async ({ data }) => {
    const { requireAdmin } = await import('./shared')
    await requireAdmin()
    const ws = (
      await db.select({ settings: workspace.settings }).from(workspace)
    ).at(0)
    await db
      .update(workspace)
      .set({
        settings: {
          ...(ws?.settings ?? {}),
          base_currency: data.currency,
        },
        updatedAt: new Date(),
      })
      .where(eq(workspace.id, 1))
    return { ok: true }
  })

/**
 * Void one ledger entry (D12). Nothing is edited and nothing is deleted:
 * this appends an exact-negative event citing the original. The typed
 * refusals are turned into sentences here rather than allowed to reject as
 * they are — Effect rejects with the tagged error itself, which carries no
 * `message`, so "already voided" would otherwise reach the dialog empty.
 */
export const voidLedgerEvent = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      table: z.enum(['investment', 'mark', 'distribution']),
      id: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { voidLedgerEventProgram, ledgerVoidMessage } =
      await import('../portfolio/reverse')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(voidLedgerEventProgram)(u.id, data)
    } catch (failure) {
      throw new Error(ledgerVoidMessage(failure))
    }
  })

/**
 * Void every live event stamped with one batch id, in one transaction — a
 * wrong forty-row import is a two-click fix. It refuses whole: one member
 * already voided leaves the batch exactly as it was.
 */
export const voidLedgerBatch = createServerFn({ method: 'POST' })
  .validator(z.object({ batchId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { voidLedgerBatchProgram, ledgerVoidMessage } =
      await import('../portfolio/reverse')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(voidLedgerBatchProgram)(u.id, data.batchId)
    } catch (failure) {
      throw new Error(ledgerVoidMessage(failure))
    }
  })
