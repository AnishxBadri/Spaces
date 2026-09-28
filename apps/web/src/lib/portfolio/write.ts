import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { activity } from '@spaces/db/schema/activity'
import {
  distribution,
  holding,
  investment,
  mark,
  round,
  roundCoInvestor,
} from '@spaces/db/schema/portfolio'
import type {
  distributionKind,
  instrument,
  markBasis,
} from '@spaces/db/schema/portfolio'
import { birthHolding } from './holding'

/**
 * **The portfolio write path** (SPA-171). `addRound`, `addInvestment`,
 * `addMark` and `addDistribution` held their bodies inline in server-fn
 * handlers, so the ledger importer calling the tables itself would have been
 * a second writer into append-only history. The bodies moved here; the
 * server fns (`lib/server/portfolio.ts`) are thin callers through
 * `effectFn`, and the import commit (`lib/import/ledger-commit.ts`) calls the
 * same four programs.
 *
 * Each program, given a transaction (`tx`), runs inside it — which is how a
 * ledger row's holding and its events land or fail together — and without
 * one opens its own. Every one of them is one or more INSERTs: there is no
 * edit and no delete here, and there may never be (D12 — a correction is a
 * compensating event, `./reverse.ts`).
 *
 * Money arrives as numbers and is turned into drizzle's `numeric` strings
 * here, at the write boundary, and nowhere else.
 *
 * Outside `lib/server/` for the barrel's reason (CLAUDE.md → Traps): the
 * import worker and the tests call these without a request.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type Instrument = (typeof instrument.enumValues)[number]
export type MarkBasis = (typeof markBasis.enumValues)[number]
export type DistributionKind = (typeof distributionKind.enumValues)[number]

/** Refused: the event names a holding that does not exist. */
export class HoldingNotFound extends Schema.TaggedError<HoldingNotFound>()(
  'HoldingNotFound',
  { holdingId: Schema.String },
) {}

export class PortfolioWriteFailed extends Schema.TaggedError<PortfolioWriteFailed>()(
  'PortfolioWriteFailed',
  { cause: Schema.Defect() },
) {}

export type PortfolioWriteFailure = HoldingNotFound | PortfolioWriteFailed

/**
 * The sentence a caller shows. A `Schema.TaggedError` carries no `message`,
 * so without this a refusal would reach a toast as an empty string.
 */
export function portfolioWriteMessage(failure: unknown): string {
  if (failure instanceof HoldingNotFound) return 'Holding not found'
  if (failure instanceof PortfolioWriteFailed) {
    const cause: unknown = failure.cause
    if (cause instanceof Error && cause.message !== '') return cause.message
  }
  return 'Could not write this entry'
}

/** A number as `numeric` stores it; absent stays absent. */
const numeric = (v: number | null | undefined): string | null =>
  v === null || v === undefined ? null : v.toString()

/** Run `body` in the caller's transaction, or in one of its own. */
function inTx<T>(
  tx: Tx | undefined,
  body: (t: Tx) => Promise<T>,
): Effect.Effect<T, PortfolioWriteFailure> {
  return Effect.tryPromise({
    try: () => (tx ? body(tx) : db.transaction(body)),
    catch: (cause) =>
      cause instanceof HoldingNotFound
        ? cause
        : new PortfolioWriteFailed({ cause }),
  })
}

async function companyOfHolding(t: Tx, holdingId: string): Promise<string> {
  const h = (
    await t
      .select({ companyId: holding.companyId })
      .from(holding)
      .where(eq(holding.id, holdingId))
  ).at(0)
  if (!h) throw new HoldingNotFound({ holdingId })
  return h.companyId
}

// ---------------------------------------------------------------------------
// Round
// ---------------------------------------------------------------------------

export type AddRoundInput = {
  companyId: string
  date: string
  kind: string
  raised?: number | null | undefined
  currency?: string | null | undefined
  preMoney?: number | null | undefined
  postMoney?: number | null | undefined
  pricePerShare?: number | null | undefined
  sharesOutstanding?: number | null | undefined
  coInvestorIds?: Array<string> | undefined
  actorId: string
}

/**
 * A financing event in a company. A round carries no `batch_id` and no
 * `reverses_id` (D12 left it out on purpose): it is a fact of the company,
 * not a summed event of ours, so a batch void never reaches it.
 */
export const addRoundProgram = Effect.fn('addRoundProgram')(function* (
  input: AddRoundInput,
  tx?: Tx,
): Effect.fn.Return<{ id: string }, PortfolioWriteFailure> {
  return yield* inTx(tx, async (t) => {
    const row = (
      await t
        .insert(round)
        .values({
          companyId: input.companyId,
          date: input.date,
          kind: input.kind,
          raised: numeric(input.raised),
          currency: input.currency ?? null,
          preMoney: numeric(input.preMoney),
          postMoney: numeric(input.postMoney),
          pricePerShare: numeric(input.pricePerShare),
          sharesOutstanding: numeric(input.sharesOutstanding),
          createdBy: input.actorId,
        })
        .returning({ id: round.id })
    ).at(0)
    if (!row) throw new Error('Round insert returned no row')
    const coInvestors = input.coInvestorIds ?? []
    if (coInvestors.length > 0)
      await t.insert(roundCoInvestor).values(
        coInvestors.map((investorEntityId) => ({
          roundId: row.id,
          investorEntityId,
        })),
      )
    await t.insert(activity).values({
      actorId: input.actorId,
      verb: 'round.added',
      subjectEntityId: input.companyId,
    })
    return { id: row.id }
  })
})

// ---------------------------------------------------------------------------
// Investment
// ---------------------------------------------------------------------------

export type AddInvestmentInput = {
  companyId: string
  /** The holding's `opened_at` if this cheque births it; the cheque's date when omitted. */
  openedAt?: string | undefined
  dealId?: string | undefined
  roundId?: string | null | undefined
  date: string
  amount: number
  currency: string
  instrument: Instrument
  shares?: number | null | undefined
  cap?: number | null | undefined
  discount?: number | null | undefined
  vehicle?: string | null | undefined
  /** The bulk-void handle (D12): the import batch that appended the cheque. */
  batchId?: string | undefined
  actorId: string
}

export type AddInvestmentResult = {
  id: string
  holdingId: string
  /** This cheque opened the company's holding. */
  holdingCreated: boolean
}

/**
 * Our cheque. Births the company's holding if it has none — idempotent, one
 * holding per company, follow-ons land on the existing row — in the same
 * transaction as the cheque.
 */
export const addInvestmentProgram = Effect.fn('addInvestmentProgram')(
  function* (
    input: AddInvestmentInput,
    tx?: Tx,
  ): Effect.fn.Return<AddInvestmentResult, PortfolioWriteFailure> {
    return yield* inTx(tx, async (t) => {
      const h = await birthHolding(
        {
          companyId: input.companyId,
          actorId: input.actorId,
          openedAt: input.openedAt ?? input.date,
        },
        t,
      )
      const row = (
        await t
          .insert(investment)
          .values({
            holdingId: h.id,
            dealId: input.dealId,
            roundId: input.roundId ?? null,
            date: input.date,
            amount: input.amount.toString(),
            currency: input.currency,
            instrument: input.instrument,
            shares: numeric(input.shares),
            cap: numeric(input.cap),
            discount: numeric(input.discount),
            vehicle: input.vehicle ?? null,
            batchId: input.batchId,
            createdBy: input.actorId,
          })
          .returning({ id: investment.id })
      ).at(0)
      if (!row) throw new Error('Investment insert returned no row')
      await t.insert(activity).values({
        actorId: input.actorId,
        verb: 'investment.added',
        subjectEntityId: input.companyId,
      })
      return { id: row.id, holdingId: h.id, holdingCreated: h.created }
    })
  },
)

// ---------------------------------------------------------------------------
// Mark
// ---------------------------------------------------------------------------

export type AddMarkInput = {
  holdingId: string
  date: string
  fairValue: number
  currency: string
  basis: MarkBasis
  batchId?: string | undefined
  actorId: string
}

export const addMarkProgram = Effect.fn('addMarkProgram')(function* (
  input: AddMarkInput,
  tx?: Tx,
): Effect.fn.Return<{ id: string }, PortfolioWriteFailure> {
  return yield* inTx(tx, async (t) => {
    const companyId = await companyOfHolding(t, input.holdingId)
    const row = (
      await t
        .insert(mark)
        .values({
          holdingId: input.holdingId,
          date: input.date,
          fairValue: input.fairValue.toString(),
          currency: input.currency,
          basis: input.basis,
          batchId: input.batchId,
          createdBy: input.actorId,
        })
        .returning({ id: mark.id })
    ).at(0)
    if (!row) throw new Error('Mark insert returned no row')
    await t.insert(activity).values({
      actorId: input.actorId,
      verb: 'mark.added',
      subjectEntityId: companyId,
    })
    return { id: row.id }
  })
})

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

export type AddDistributionInput = {
  holdingId: string
  date: string
  amount: number
  currency: string
  kind: DistributionKind
  sharesSold?: number | null | undefined
  pricePerShare?: number | null | undefined
  batchId?: string | undefined
  actorId: string
}

/** Realized proceeds; a write-off is amount 0, kind `writeoff`. */
export const addDistributionProgram = Effect.fn('addDistributionProgram')(
  function* (
    input: AddDistributionInput,
    tx?: Tx,
  ): Effect.fn.Return<{ id: string }, PortfolioWriteFailure> {
    return yield* inTx(tx, async (t) => {
      const companyId = await companyOfHolding(t, input.holdingId)
      const row = (
        await t
          .insert(distribution)
          .values({
            holdingId: input.holdingId,
            date: input.date,
            amount: input.amount.toString(),
            currency: input.currency,
            kind: input.kind,
            sharesSold: numeric(input.sharesSold),
            pricePerShare: numeric(input.pricePerShare),
            batchId: input.batchId,
            createdBy: input.actorId,
          })
          .returning({ id: distribution.id })
      ).at(0)
      if (!row) throw new Error('Distribution insert returned no row')
      await t.insert(activity).values({
        actorId: input.actorId,
        verb:
          input.kind === 'writeoff'
            ? 'holding.writtenoff'
            : 'distribution.added',
        subjectEntityId: companyId,
      })
      return { id: row.id }
    })
  },
)
