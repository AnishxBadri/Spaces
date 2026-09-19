import { Effect, Schema } from 'effect'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  distribution,
  holding,
  investment,
  mark,
} from '@spaces/db/schema/portfolio'
import { activity } from '@spaces/db/schema/activity'

/**
 * Ledger corrections are appends (D12, SPA-150).
 *
 * `investment`, `mark` and `distribution` still have no edit path and no
 * delete path. A wrong entry is answered by a *compensating* entry: same
 * holding, the original's date, negated amount and shares, `reverses_id`
 * citing the row it voids and `created_by` naming who voided it. The
 * original row is read and never written — the void is one INSERT.
 *
 * Why the original's date and not today's: the pair has to cancel at every
 * as-of date on or after the original, so cost basis, MOIC and XIRR return
 * to *exactly* their pre-entry values. What says when the correction
 * happened is the reversal's `created_at`, which the loader hands the pure
 * libs as `reversedAt` — an as-of date before the void still sees the
 * original (`@spaces/core/portfolio/reversal`).
 *
 * `fx_rate` has no void flow and needs none: it is a lookup rather than a
 * summed event, its `rate_to_base > 0` CHECK forbids a negated row, and
 * `setFxRate` already upserts on (currency, date).
 *
 * Two refusals, both by name and both also enforced by Postgres: an event
 * already reversed cannot be reversed twice (the partial unique index on
 * `reverses_id` catches the race the check cannot), and a reversal cannot
 * itself be reversed.
 */

export const LEDGER_TABLES = ['investment', 'mark', 'distribution'] as const
export type LedgerTable = (typeof LEDGER_TABLES)[number]

const LABEL: Record<LedgerTable, string> = {
  investment: 'check',
  mark: 'mark',
  distribution: 'distribution',
}

export class LedgerEventNotFound extends Schema.TaggedError<LedgerEventNotFound>()(
  'LedgerEventNotFound',
  { table: Schema.String, id: Schema.String },
) {}

/** Refused: a compensating event already cites this row. */
export class AlreadyReversed extends Schema.TaggedError<AlreadyReversed>()(
  'AlreadyReversed',
  { table: Schema.String, id: Schema.String },
) {}

/** Refused: the row is itself a compensating event. */
export class CannotReverseReversal extends Schema.TaggedError<CannotReverseReversal>()(
  'CannotReverseReversal',
  { table: Schema.String, id: Schema.String },
) {}

/** Refused: no live event carries that batch id. */
export class LedgerBatchEmpty extends Schema.TaggedError<LedgerBatchEmpty>()(
  'LedgerBatchEmpty',
  { batchId: Schema.String },
) {}

export class LedgerQueryFailed extends Schema.TaggedError<LedgerQueryFailed>()(
  'LedgerQueryFailed',
  { cause: Schema.Defect() },
) {}

export type LedgerVoidFailure =
  | LedgerEventNotFound
  | AlreadyReversed
  | CannotReverseReversal
  | LedgerBatchEmpty
  | LedgerQueryFailed

/**
 * The sentence the dialog is shown. `Effect.runPromise` rejects with the
 * typed error itself and a `Schema.TaggedError` carries no `message`, so
 * without this a refusal would reach the confirm as an empty string.
 */
export function ledgerVoidMessage(failure: unknown): string {
  if (failure instanceof AlreadyReversed)
    return `This ${LABEL[asTable(failure.table)]} has already been voided`
  if (failure instanceof CannotReverseReversal)
    return 'A reversal cannot be reversed — it is the correction'
  if (failure instanceof LedgerEventNotFound)
    return `That ${LABEL[asTable(failure.table)]} no longer exists`
  if (failure instanceof LedgerBatchEmpty)
    return 'Nothing left to void in that batch'
  return 'Could not void this entry'
}

function asTable(name: string): LedgerTable {
  const hit = LEDGER_TABLES.find((t) => t === name)
  return hit ?? 'investment'
}

/**
 * Thrown inside the transaction so drizzle rolls it back, caught on the way
 * out and turned into the typed failure. A refusal has to travel as an
 * exception because the rollback is the point: a batch that refuses its
 * third row must leave no trace of the first two.
 */
class VoidRollback extends Error {
  constructor(readonly failure: LedgerVoidFailure) {
    super('void refused')
    this.name = 'VoidRollback'
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Exact negation on the string drizzle hands back, rather than a Number
 * round-trip: `numeric(20, 4)` is wider than a double, and a sign flip is
 * the one edit that needs no arithmetic. `-0` is not a correction.
 */
function negate(value: string | null): string | null {
  if (value === null) return null
  if (Number(value) === 0) return value
  return value.startsWith('-') ? value.slice(1) : `-${value}`
}

/**
 * Postgres refused the second void through the partial unique index —
 * `<table>_reverses_unique`, which is the backstop behind `assertLive` for
 * two voids racing in separate transactions. The constraint names the table.
 */
function reversesUniqueViolation(cause: unknown): LedgerTable | null {
  if (typeof cause !== 'object' || cause === null) return null
  const e: { code?: unknown; constraint?: unknown } = cause
  if (e.code !== '23505' || typeof e.constraint !== 'string') return null
  const name = e.constraint
  return LEDGER_TABLES.find((t) => name === `${t}_reverses_unique`) ?? null
}

type Voided = { table: LedgerTable; id: string; holdingId: string }

/**
 * Append one compensating event. Reads the original, refuses by name, and
 * inserts the negation — the original row is never in an UPDATE or a DELETE.
 */
async function appendReversal(
  tx: Tx,
  table: LedgerTable,
  id: string,
  userId: string,
): Promise<Voided> {
  if (table === 'investment') {
    const row = (
      await tx.select().from(investment).where(eq(investment.id, id))
    ).at(0)
    if (!row) throw new VoidRollback(new LedgerEventNotFound({ table, id }))
    if (row.reversesId !== null)
      throw new VoidRollback(new CannotReverseReversal({ table, id }))
    await assertLive(tx, table, id)
    const [added] = await tx
      .insert(investment)
      .values({
        holdingId: row.holdingId,
        dealId: row.dealId,
        roundId: row.roundId,
        date: row.date,
        amount: negate(row.amount) ?? row.amount,
        currency: row.currency,
        instrument: row.instrument,
        shares: negate(row.shares),
        // Terms, not quantities: the negated amount over the same cap is
        // what cancels the implied %.
        cap: row.cap,
        discount: row.discount,
        vehicle: row.vehicle,
        reversesId: row.id,
        // A reversal never joins the batch it corrects — a second batch
        // void would otherwise try to reverse the reversals.
        batchId: null,
        createdBy: userId,
      })
      .returning({ id: investment.id })
    return { table, id: added.id, holdingId: row.holdingId }
  }

  if (table === 'mark') {
    const row = (await tx.select().from(mark).where(eq(mark.id, id))).at(0)
    if (!row) throw new VoidRollback(new LedgerEventNotFound({ table, id }))
    if (row.reversesId !== null)
      throw new VoidRollback(new CannotReverseReversal({ table, id }))
    await assertLive(tx, table, id)
    const [added] = await tx
      .insert(mark)
      .values({
        holdingId: row.holdingId,
        date: row.date,
        fairValue: negate(row.fairValue) ?? row.fairValue,
        currency: row.currency,
        basis: row.basis,
        reversesId: row.id,
        batchId: null,
        createdBy: userId,
      })
      .returning({ id: mark.id })
    return { table, id: added.id, holdingId: row.holdingId }
  }

  const row = (
    await tx.select().from(distribution).where(eq(distribution.id, id))
  ).at(0)
  if (!row) throw new VoidRollback(new LedgerEventNotFound({ table, id }))
  if (row.reversesId !== null)
    throw new VoidRollback(new CannotReverseReversal({ table, id }))
  await assertLive(tx, table, id)
  const [added] = await tx
    .insert(distribution)
    .values({
      holdingId: row.holdingId,
      date: row.date,
      amount: negate(row.amount) ?? row.amount,
      currency: row.currency,
      kind: row.kind,
      sharesSold: negate(row.sharesSold),
      pricePerShare: row.pricePerShare,
      reversesId: row.id,
      batchId: null,
      createdBy: userId,
    })
    .returning({ id: distribution.id })
  return { table, id: added.id, holdingId: row.holdingId }
}

/** Refuse a second void before writing one. The index catches the race. */
async function assertLive(
  tx: Tx,
  table: LedgerTable,
  id: string,
): Promise<void> {
  const existing =
    table === 'investment'
      ? await tx
          .select({ id: investment.id })
          .from(investment)
          .where(eq(investment.reversesId, id))
          .limit(1)
      : table === 'mark'
        ? await tx
            .select({ id: mark.id })
            .from(mark)
            .where(eq(mark.reversesId, id))
            .limit(1)
        : await tx
            .select({ id: distribution.id })
            .from(distribution)
            .where(eq(distribution.reversesId, id))
            .limit(1)
  if (existing.length > 0)
    throw new VoidRollback(new AlreadyReversed({ table, id }))
}

async function companyOf(tx: Tx, holdingId: string): Promise<string | null> {
  const row = (
    await tx
      .select({ companyId: holding.companyId })
      .from(holding)
      .where(eq(holding.id, holdingId))
  ).at(0)
  return row?.companyId ?? null
}

async function writeActivity(
  tx: Tx,
  voided: Array<Voided>,
  userId: string,
  verbSuffix: 'voided' | 'batch_voided',
): Promise<void> {
  const companies = new Map<string, string>()
  for (const v of voided) {
    if (companies.has(v.holdingId)) continue
    const companyId = await companyOf(tx, v.holdingId)
    if (companyId !== null) companies.set(v.holdingId, companyId)
  }
  const rows = voided.flatMap((v) => {
    const companyId = companies.get(v.holdingId)
    if (companyId === undefined) return []
    return [
      {
        actorId: userId,
        verb: `${v.table}.${verbSuffix}`,
        subjectEntityId: companyId,
        meta: { reversalId: v.id },
      },
    ]
  })
  if (rows.length > 0) await tx.insert(activity).values(rows)
}

/** Turn the rollback exception back into the typed failure it carries. */
function asFailure(cause: unknown): LedgerVoidFailure {
  if (cause instanceof VoidRollback) return cause.failure
  const raced = reversesUniqueViolation(cause)
  if (raced !== null) return new AlreadyReversed({ table: raced, id: '' })
  return new LedgerQueryFailed({ cause })
}

/**
 * Void one ledger event. Returns the id of the compensating event, which is
 * the only row this writes besides its activity line.
 */
export const voidLedgerEventProgram = Effect.fn('voidLedgerEventProgram')(
  function* (
    userId: string,
    input: { table: LedgerTable; id: string },
  ): Effect.fn.Return<{ reversalId: string }, LedgerVoidFailure> {
    const voided = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const v = await appendReversal(tx, input.table, input.id, userId)
          await writeActivity(tx, [v], userId, 'voided')
          return v
        }),
      catch: asFailure,
    })
    return { reversalId: voided.id }
  },
)

/**
 * Void every live event stamped with one `batch_id`, in a single
 * transaction — a wrong forty-row import is one refusal or forty
 * compensating rows, never nineteen. Partial is not an outcome: the first
 * row that refuses rolls the whole batch back.
 */
export const voidLedgerBatchProgram = Effect.fn('voidLedgerBatchProgram')(
  function* (
    userId: string,
    batchId: string,
  ): Effect.fn.Return<{ reversed: number }, LedgerVoidFailure> {
    const voided = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const members: Array<{ table: LedgerTable; id: string }> = []
          const [invRows, markRows, distRows] = await Promise.all([
            tx
              .select({ id: investment.id })
              .from(investment)
              .where(
                and(
                  eq(investment.batchId, batchId),
                  isNull(investment.reversesId),
                ),
              ),
            tx
              .select({ id: mark.id })
              .from(mark)
              .where(and(eq(mark.batchId, batchId), isNull(mark.reversesId))),
            tx
              .select({ id: distribution.id })
              .from(distribution)
              .where(
                and(
                  eq(distribution.batchId, batchId),
                  isNull(distribution.reversesId),
                ),
              ),
          ])
          for (const r of invRows)
            members.push({ table: 'investment', id: r.id })
          for (const r of markRows) members.push({ table: 'mark', id: r.id })
          for (const r of distRows)
            members.push({ table: 'distribution', id: r.id })
          if (members.length === 0)
            throw new VoidRollback(new LedgerBatchEmpty({ batchId }))

          // Refuse the whole batch before writing any of it, so the caller
          // never has to reason about how far it got.
          await assertBatchLive(tx, members)

          const out: Array<Voided> = []
          for (const m of members) {
            out.push(await appendReversal(tx, m.table, m.id, userId))
          }
          await writeActivity(tx, out, userId, 'batch_voided')
          return out
        }),
      catch: asFailure,
    })
    return { reversed: voided.length }
  },
)

/** Every member must still stand; one already-voided row refuses the batch. */
async function assertBatchLive(
  tx: Tx,
  members: Array<{ table: LedgerTable; id: string }>,
): Promise<void> {
  for (const table of LEDGER_TABLES) {
    const ids = members.filter((m) => m.table === table).map((m) => m.id)
    if (ids.length === 0) continue
    const hits =
      table === 'investment'
        ? await tx
            .select({ reversesId: investment.reversesId })
            .from(investment)
            .where(inArray(investment.reversesId, ids))
        : table === 'mark'
          ? await tx
              .select({ reversesId: mark.reversesId })
              .from(mark)
              .where(inArray(mark.reversesId, ids))
          : await tx
              .select({ reversesId: distribution.reversesId })
              .from(distribution)
              .where(inArray(distribution.reversesId, ids))
    const hit = hits.at(0)?.reversesId
    if (hit != null)
      throw new VoidRollback(new AlreadyReversed({ table, id: hit }))
  }
}
