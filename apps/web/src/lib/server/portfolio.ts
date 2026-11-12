import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { workspace } from '@spaces/db/schema'
import { fxRate } from '@spaces/db/schema/portfolio'
import { baseCurrency, loadFxRates, loadPortfolio } from '../portfolio/detail'
import { ccy, isoDate, markInput, money, roundInput } from '../portfolio/inputs'
import { requireAdmin, requireUser } from './shared'
import { input } from './input'
import { serverQuery } from './query'

/**
 * The financial engine's server layer. Events are append-only; every
 * aggregate is computed at read by the pure portfolio lib. Base currency
 * lives in workspace.settings.
 * - The reversal reader contract: the pure libs are handed originals only,
 *   each stamped with `reversedAt` (stated on the portfolio detail loader).
 * - These handlers are the auth gate and the write paths.
 */

const uuid = Schema.String.check(Schema.isUUID())

const listHoldingsProgram = Effect.fn('listHoldingsProgram')(function* (
  asOf: string | undefined,
) {
  return yield* Effect.promise(() => loadPortfolio(asOf))
})

/**
 * The book: per-holding metrics in native-or-base, plus the base-currency
 * roll-up. Portfolio and Today both read it; the body is `loadPortfolio`.
 */
export const listHoldings = createServerFn()
  .validator(
    input(
      Schema.UndefinedOr(
        Schema.Struct({ asOf: Schema.optional(Schema.String) }),
      ),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(listHoldingsProgram(data?.asOf))
  })

const getHoldingProgram = Effect.fn('getHoldingProgram')(function* (
  id: string,
  asOf: string | undefined,
) {
  const { loadHoldingDetail } = yield* Effect.promise(
    () => import('../portfolio/detail'),
  )
  return yield* Effect.promise(() => loadHoldingDetail(id, asOf))
})

/** The tear-sheet read: every event, plus computed metrics and ownership. */
export const getHolding = createServerFn()
  .validator(
    input(Schema.Struct({ id: uuid, asOf: Schema.optional(Schema.String) })),
  )
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(getHoldingProgram(data.id, data.asOf))
  })

/**
 * The four event writers are thin callers: the bodies are the portfolio write
 * programs, which the ledger import commit calls too, so history has one
 * writer.
 */
export const addRound = createServerFn({ method: 'POST' })
  .validator(input(roundInput))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { addRoundProgram, portfolioWriteMessage } =
      await import('../portfolio/write')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(addRoundProgram)({ ...data, actorId: u.id })
    } catch (failure) {
      throw new Error(portfolioWriteMessage(failure))
    }
  })

export const addInvestment = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        companyId: uuid,
        dealId: Schema.optional(uuid),
        roundId: Schema.optional(uuid),
        date: isoDate,
        amount: money,
        currency: ccy,
        instrument: Schema.Literals([
          'priced',
          'safe_post_money',
          'safe_pre_money',
          'ccd',
        ]),
        shares: Schema.optional(money),
        cap: Schema.optional(money),
        discount: Schema.optional(
          Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
        ),
        vehicle: Schema.optional(Schema.Trim.check(Schema.isMaxLength(120))),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { addInvestmentProgram, portfolioWriteMessage } =
      await import('../portfolio/write')
    const { effectFn } = await import('./effect')
    try {
      const out = await effectFn(addInvestmentProgram)({
        ...data,
        actorId: u.id,
      })
      return { id: out.id, holdingId: out.holdingId }
    } catch (failure) {
      throw new Error(portfolioWriteMessage(failure))
    }
  })

export const addMark = createServerFn({ method: 'POST' })
  .validator(input(markInput))
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { addMarkProgram, portfolioWriteMessage } =
      await import('../portfolio/write')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(addMarkProgram)({ ...data, actorId: u.id })
    } catch (failure) {
      throw new Error(portfolioWriteMessage(failure))
    }
  })

export const addDistribution = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        holdingId: uuid,
        date: isoDate,
        amount: money,
        currency: ccy,
        kind: Schema.Literals(['exit', 'secondary', 'dividend', 'writeoff']),
        sharesSold: Schema.optional(money),
        pricePerShare: Schema.optional(money),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { addDistributionProgram, portfolioWriteMessage } =
      await import('../portfolio/write')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(addDistributionProgram)({ ...data, actorId: u.id })
    } catch (failure) {
      throw new Error(portfolioWriteMessage(failure))
    }
  })

const setFxRateProgram = Effect.fn('setFxRateProgram')(function* (
  data: { currency: string; date: string; rateToBase: number },
  actorId: string,
) {
  yield* serverQuery(() =>
    db
      .insert(fxRate)
      .values({
        currency: data.currency,
        date: data.date,
        rateToBase: data.rateToBase.toString(),
        createdBy: actorId,
      })
      .onConflictDoUpdate({
        target: [fxRate.currency, fxRate.date],
        set: { rateToBase: data.rateToBase.toString() },
      }),
  )
  return { ok: true }
})

/** Upsert on (currency, date): correcting a rate just recomputes. */
export const setFxRate = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        currency: ccy,
        date: isoDate,
        rateToBase: Schema.Finite.check(Schema.isGreaterThan(0)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(setFxRateProgram(data, u.id))
  })

const listFxRatesProgram = Effect.fn('listFxRatesProgram')(function* () {
  const [base, rates] = yield* Effect.all(
    [Effect.promise(() => baseCurrency()), Effect.promise(() => loadFxRates())],
    { concurrency: 'unbounded' },
  )
  return { baseCurrency: base, rates }
})

export const listFxRates = createServerFn().handler(async () => {
  await requireUser()
  return Effect.runPromise(listFxRatesProgram())
})

const setBaseCurrencyProgram = Effect.fn('setBaseCurrencyProgram')(function* (
  currency: string,
) {
  const ws = (yield* serverQuery(() =>
    db.select({ settings: workspace.settings }).from(workspace),
  )).at(0)
  yield* serverQuery(() =>
    db
      .update(workspace)
      .set({
        settings: {
          ...(ws?.settings ?? {}),
          base_currency: currency,
        },
        updatedAt: new Date(),
      })
      .where(eq(workspace.id, 1)),
  )
  return { ok: true }
})

/**
 * Base currency is a workspace-settings key, admin-only: changing it
 * re-denominates every roll-up at next read (nothing stored converts).
 */
export const setBaseCurrency = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ currency: ccy })))
  .handler(async ({ data }) => {
    await requireAdmin()
    return Effect.runPromise(setBaseCurrencyProgram(data.currency))
  })

/**
 * Void one ledger entry. Nothing is edited and nothing is deleted:
 * this appends an exact-negative event citing the original. The typed
 * refusals are turned into sentences here rather than allowed to reject as
 * they are — Effect rejects with the tagged error itself, which carries no
 * `message`, so "already voided" would otherwise reach the dialog empty.
 */
export const voidLedgerEvent = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        table: Schema.Literals(['investment', 'mark', 'distribution']),
        id: uuid,
      }),
    ),
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
  .validator(input(Schema.Struct({ batchId: uuid })))
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
