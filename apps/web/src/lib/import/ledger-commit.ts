import { Effect } from 'effect'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import { entity, importBatch, importRow } from '@spaces/db/schema'
import {
  distribution,
  holding,
  investment,
  mark,
  round,
} from '@spaces/db/schema/portfolio'
import { emptyRun } from '@spaces/core/import/commit'
import { isLedgerPlan } from '@spaces/core/import/ledger'
import { ledgerVoidLine, missingRates } from '@spaces/core/import/ledger-commit'
import { resolveEntityInTx } from '@spaces/core/writes/entities/resolve'
import { sweepNameSimilarity } from '@spaces/core/writes/entities/sweep'
import { enqueueSourceEmbed } from '#/lib/ai/enqueue-embed'
import { baseCurrency, loadFxRates } from '#/lib/portfolio/detail'
import {
  HoldingNotFound,
  PortfolioWriteFailed,
  addDistributionProgram,
  addInvestmentProgram,
  addMarkProgram,
  addRoundProgram,
} from '#/lib/portfolio/write'
import { ImportFailed, ImportRefused } from './stage'
import type { Tx } from '@spaces/core/writes/attributes/values'
import type { EmbedSource } from '@spaces/core/writes/ai/chunk-sources'
import type { CommitRun } from '@spaces/core/import/commit'
import type {
  LedgerCommitted,
  LedgerEventKind,
  MissingRate,
} from '@spaces/core/import/ledger-commit'
import type { LedgerRoundEvent, LedgerRowPlan } from '@spaces/db/schema/import'
import type { ImportFailure } from './stage'

/**
 * **Ledger commit** (SPA-171, import-9; CONTEXT.md phase 15 item 9). The
 * `import.commit` job's body for a ledger batch: the stored plan executed
 * through the portfolio write path (`#/lib/portfolio/write`) — the same four
 * programs the server fns call, so the importer is not a second writer into
 * append-only history. **Each row in its own transaction**: the company
 * (attached, or created as the plan said), then its round, then our cheque —
 * which births the company's holding if it has none, dated the earliest
 * cheque the batch plans for that company — then its mark and proceeds. A
 * failure anywhere rolls that row back alone, leaves `error` naming the
 * company, and the next row carries on.
 *
 * **Nothing is overwritten, and nothing is appended twice.** Every write is
 * an INSERT; this module holds no UPDATE and no DELETE against `round`,
 * `investment`, `mark` or `distribution` (asserted by
 * `ledger-commit.test.ts`), and the correction for a wrong batch is the
 * shipped batch void (D12). Idempotence is two layers:
 *
 * 1. A row whose plan holds `ledger.committed` (written in the row's own
 *    transaction) is passed over by every later run.
 * 2. Before appending an event, a live row with its natural key is looked
 *    for — same holding, date, amount, currency and instrument / basis /
 *    kind, `reverses_id` null and not itself reversed — and reused if found.
 *    For a cheque or proceeds, rows this same batch appended are not
 *    candidates: two equal cheques in one sheet are two cheques, and a crashed
 *    row never leaves its own events behind (they share its transaction). A
 *    mark is a statement of value, so an equal one is the same statement
 *    wherever it came from. A round is reused by company, kind and date.
 *    So cheques and proceeds never dedupe against rows of their own batch —
 *    two equal cheques in one sheet stay two, because each is money that
 *    moved and the cost basis sums them — while marks dedupe everywhere,
 *    because a mark states a value rather than moving money, and the same
 *    statement made twice is still one.
 *
 * Every investment, mark and distribution appended carries
 * `batch_id = import_batch.id`, the handle `voidLedgerBatchProgram` grabs; a
 * round carries none (D12 excluded it), so its id is recorded on the plan.
 *
 * Outside `lib/server/` for the barrel's reason (CLAUDE.md → Traps).
 */

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ImportFailed({ cause }) })

type LoadedLedgerRow = {
  rowNum: number
  plan: LedgerRowPlan
  entityId: string | null
  error: string | null
}

type RunContext = {
  batchId: string
  userId: string
  /** Create key → the company it became (this run's, and earlier runs'). */
  made: Map<string, string>
  /** Company key → the earliest cheque date the batch plans for it. */
  openedAt: Map<string, string>
  byNum: Map<number, LoadedLedgerRow>
}

type AfterCommit = () => Promise<void>

type RowWrite = {
  companyId: string
  /** A company this row created — its create key, for the rows after it. */
  created: string | null
  committed: LedgerCommitted
  after: Array<AfterCommit>
}

const IMPORT_SOURCE = { class: 'import' } as const

const loadLedgerRows = (batchId: string) =>
  query(() =>
    db
      .select({
        rowNum: importRow.rowNum,
        plan: importRow.plan,
        entityId: importRow.entityId,
        error: importRow.error,
      })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
      .orderBy(asc(importRow.rowNum))
      .then((rows) =>
        rows.flatMap((r): Array<LoadedLedgerRow> =>
          r.plan && isLedgerPlan(r.plan) ? [{ ...r, plan: r.plan }] : [],
        ),
      ),
  )

/** The company as the receipt and a failure name it. */
export function companyNameOf(plan: LedgerRowPlan): string {
  return plan.references?.at(0)?.name ?? plan.name ?? 'this company'
}

/** A row's failure, naming the company it failed on. */
function reasonOf(plan: LedgerRowPlan, failure: unknown): string {
  const inner: unknown =
    failure instanceof PortfolioWriteFailed ? failure.cause : failure
  const text =
    failure instanceof HoldingNotFound
      ? 'its holding no longer exists'
      : failure instanceof ImportRefused
        ? failure.reason
        : inner instanceof Error && inner.message !== ''
          ? inner.message
          : 'could not write this row'
  return `${companyNameOf(plan)} · ${text}`.slice(0, 300)
}

const lands = (plan: LedgerRowPlan) =>
  (plan.verdict === 'attach' || plan.verdict === 'create') &&
  plan.ledger.events !== null &&
  plan.ledger.company !== null

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

/** The row's company: the record the plan found, or the create it planned. */
async function companyOf(
  tx: Tx,
  ctx: RunContext,
  plan: LedgerRowPlan,
): Promise<{ id: string; created: string | null; after: Array<AfterCommit> }> {
  const ref = plan.references?.at(0)
  if (ref?.to === 'record') {
    const live = (
      await tx
        .select({ id: entity.id })
        .from(entity)
        .where(and(eq(entity.id, ref.entityId), isNull(entity.mergedIntoId)))
    ).at(0)
    if (!live) throw new Error('the company was merged or removed')
    return { id: live.id, created: null, after: [] }
  }
  if (ref?.to !== 'create') throw new Error('the row names no company')
  const made = ctx.made.get(ref.key)
  if (made !== undefined) return { id: made, created: null, after: [] }
  const out = await resolveEntityInTx(tx, {
    kind: 'company',
    name: ref.createName ?? ref.name,
    keys: ref.identity,
    source: IMPORT_SOURCE,
    createdBy: ctx.userId,
    valuesSource: 'import',
    batchId: ctx.batchId,
  })
  const reembed: Array<EmbedSource> = out.reembed
  const after: Array<AfterCommit> = [
    async () => {
      for (const s of reembed) await enqueueSourceEmbed(s)
    },
  ]
  const sweep = out.sweepName
  if (sweep !== null)
    after.push(async () => {
      await sweepNameSimilarity(out.entityId, sweep).catch((err: unknown) =>
        console.error('[import] fuzzy sweep failed', err),
      )
    })
  return { id: out.entityId, created: ref.key, after }
}

/** A round of the company with this kind and date, or a new one. */
async function roundFor(
  tx: Tx,
  ctx: RunContext,
  companyId: string,
  r: LedgerRoundEvent,
): Promise<{ id: string; reused: boolean }> {
  const existing = (
    await tx
      .select({ id: round.id })
      .from(round)
      .where(
        and(
          eq(round.companyId, companyId),
          eq(round.date, r.date),
          sql`lower(trim(${round.kind})) = ${r.kind.trim().toLowerCase()}`,
        ),
      )
      .limit(1)
  ).at(0)
  if (existing) return { id: existing.id, reused: true }
  const added = await Effect.runPromise(
    addRoundProgram(
      {
        companyId,
        date: r.date,
        kind: r.kind,
        raised: r.raised,
        currency: r.currency,
        preMoney: r.preMoney,
        postMoney: r.postMoney,
        pricePerShare: r.pricePerShare,
        sharesOutstanding: r.sharesOutstanding,
        actorId: ctx.userId,
      },
      tx,
    ),
  )
  return { id: added.id, reused: false }
}

/** `id` is not cited by a compensating event of its own table. */
const notReversed = (
  table: 'investment' | 'mark' | 'distribution',
  id: AnyPgColumn,
) =>
  sql`not exists (select 1 from ${sql.identifier(table)} r where r.reverses_id = ${id})`

async function writeLedgerRow(
  tx: Tx,
  ctx: RunContext,
  row: LoadedLedgerRow,
): Promise<RowWrite> {
  // The batch cannot have moved under the run: a mapping change takes this
  // row lock and returns the batch to `staged`.
  const status = (
    await tx
      .select({ status: importBatch.status })
      .from(importBatch)
      .where(eq(importBatch.id, ctx.batchId))
      .for('share')
  ).at(0)?.status
  if (status !== 'planned' && status !== 'committed')
    throw new ImportRefused({ reason: 'the import changed during the commit' })

  const plan = row.plan
  const events = plan.ledger.events
  const key = plan.ledger.company
  if (!events || key === null) throw new Error('the row has no events')
  const company = await companyOf(tx, ctx, plan)
  const reused: Array<LedgerEventKind> = []

  // 1. The round: the row's own, or the one its cheque joins.
  let ownRound: string | null = null
  let roundId: string | null = null
  if (events.round) {
    const r = await roundFor(tx, ctx, company.id, events.round)
    if (r.reused) reused.push('round')
    ownRound = r.id
    roundId = r.id
  } else if (events.investment.roundRow !== null) {
    const joined = ctx.byNum.get(events.investment.roundRow)?.plan.ledger.events
      ?.round
    if (joined) roundId = (await roundFor(tx, ctx, company.id, joined)).id
  }

  // 2. Our cheque, which births the holding when the company has none.
  const i = events.investment
  const held = (
    await tx
      .select({ id: holding.id })
      .from(holding)
      .where(eq(holding.companyId, company.id))
  ).at(0)
  const sameCheque = held
    ? (
        await tx
          .select({ id: investment.id })
          .from(investment)
          .where(
            and(
              eq(investment.holdingId, held.id),
              eq(investment.date, i.date),
              eq(investment.amount, i.amount.toString()),
              eq(investment.currency, i.currency),
              eq(investment.instrument, i.instrument),
              isNull(investment.reversesId),
              sql`${investment.batchId} is distinct from ${ctx.batchId}`,
              notReversed('investment', investment.id),
            ),
          )
          .limit(1)
      ).at(0)
    : undefined
  let holdingId: string
  let holdingBorn = false
  let investmentId: string
  if (held && sameCheque) {
    reused.push('investment')
    holdingId = held.id
    investmentId = sameCheque.id
  } else {
    const added = await Effect.runPromise(
      addInvestmentProgram(
        {
          companyId: company.id,
          openedAt: ctx.openedAt.get(key) ?? i.date,
          roundId,
          date: i.date,
          amount: i.amount,
          currency: i.currency,
          instrument: i.instrument,
          shares: i.shares,
          cap: i.cap,
          discount: i.discount,
          vehicle: i.vehicle,
          batchId: ctx.batchId,
          actorId: ctx.userId,
        },
        tx,
      ),
    )
    holdingId = added.holdingId
    holdingBorn = added.holdingCreated
    investmentId = added.id
  }

  // 3. The mark and the proceeds, on that holding.
  let markId: string | null = null
  const m = events.mark
  if (m) {
    const same = (
      await tx
        .select({ id: mark.id })
        .from(mark)
        .where(
          and(
            eq(mark.holdingId, holdingId),
            eq(mark.date, m.date),
            eq(mark.fairValue, m.fairValue.toString()),
            eq(mark.currency, m.currency),
            eq(mark.basis, m.basis),
            isNull(mark.reversesId),
            notReversed('mark', mark.id),
          ),
        )
        .limit(1)
    ).at(0)
    if (same) reused.push('mark')
    markId = same
      ? same.id
      : (
          await Effect.runPromise(
            addMarkProgram(
              {
                holdingId,
                date: m.date,
                fairValue: m.fairValue,
                currency: m.currency,
                basis: m.basis,
                batchId: ctx.batchId,
                actorId: ctx.userId,
              },
              tx,
            ),
          )
        ).id
  }

  let distributionId: string | null = null
  const d = events.distribution
  if (d) {
    const same = (
      await tx
        .select({ id: distribution.id })
        .from(distribution)
        .where(
          and(
            eq(distribution.holdingId, holdingId),
            eq(distribution.date, d.date),
            eq(distribution.amount, d.amount.toString()),
            eq(distribution.currency, d.currency),
            eq(distribution.kind, d.kind),
            isNull(distribution.reversesId),
            sql`${distribution.batchId} is distinct from ${ctx.batchId}`,
            notReversed('distribution', distribution.id),
          ),
        )
        .limit(1)
    ).at(0)
    if (same) reused.push('distribution')
    distributionId = same
      ? same.id
      : (
          await Effect.runPromise(
            addDistributionProgram(
              {
                holdingId,
                date: d.date,
                amount: d.amount,
                currency: d.currency,
                kind: d.kind,
                batchId: ctx.batchId,
                actorId: ctx.userId,
              },
              tx,
            ),
          )
        ).id
  }

  const committed: LedgerCommitted = {
    holdingId,
    holdingBorn,
    investmentId,
    ...(ownRound !== null ? { roundId: ownRound } : {}),
    ...(markId !== null ? { markId } : {}),
    ...(distributionId !== null ? { distributionId } : {}),
    ...(reused.length > 0 ? { reused } : {}),
  }
  await tx
    .update(importRow)
    .set({
      entityId: company.id,
      error: null,
      plan: { ...plan, ledger: { ...plan.ledger, committed } },
    })
    .where(
      and(eq(importRow.batchId, ctx.batchId), eq(importRow.rowNum, row.rowNum)),
    )
  return {
    companyId: company.id,
    created: company.created,
    committed,
    after: company.after,
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * A ledger batch's `import.commit` run. `commitImportProgram` has already
 * refused a batch that cannot commit; a committed batch asked again answers
 * with a run that wrote nothing.
 */
export const commitLedgerProgram = Effect.fn('commitLedgerProgram')(function* (
  batch: { id: string; status: string },
  input: { userId: string; onlyFailed: boolean },
): Effect.fn.Return<CommitRun, ImportFailure> {
  const rows = yield* loadLedgerRows(batch.id)
  const run = emptyRun()
  const isDone = (r: LoadedLedgerRow) =>
    r.entityId !== null || r.plan.ledger.committed !== undefined

  if (batch.status === 'committed' && !input.onlyFailed) {
    run.unchanged = rows.filter(isDone).length
    return run
  }

  const made = new Map<string, string>()
  const openedAt = new Map<string, string>()
  for (const r of rows) {
    const key = r.plan.ledger.company
    if (key === null || !lands(r.plan)) continue
    if (r.entityId !== null && !key.startsWith('entity:'))
      made.set(key, r.entityId)
    const date = r.plan.ledger.events?.investment.date
    const held = openedAt.get(key)
    if (date !== undefined && (held === undefined || date < held))
      openedAt.set(key, date)
  }
  const ctx: RunContext = {
    batchId: batch.id,
    userId: input.userId,
    made,
    openedAt,
    byNum: new Map(rows.map((r) => [r.rowNum, r])),
  }

  for (const row of rows) {
    if (!lands(row.plan)) continue
    if (isDone(row)) {
      run.unchanged += 1
      continue
    }
    if (input.onlyFailed && row.error === null) continue
    const outcome = yield* Effect.tryPromise({
      try: () => db.transaction((tx) => writeLedgerRow(tx, ctx, row)),
      catch: (cause) => cause,
    }).pipe(Effect.result)

    if (outcome._tag === 'Failure') {
      const reason = reasonOf(row.plan, outcome.failure)
      yield* query(() =>
        db
          .update(importRow)
          .set({ error: reason })
          .where(
            and(
              eq(importRow.batchId, batch.id),
              eq(importRow.rowNum, row.rowNum),
            ),
          ),
      )
      run.failed += 1
      continue
    }
    const write = outcome.success
    if (write.created !== null) made.set(write.created, write.companyId)
    for (const step of write.after)
      yield* Effect.promise(() =>
        step().catch((err: unknown) =>
          console.error('[import] after-commit step failed', err),
        ),
      )
    run.written += 1
  }

  if (!input.onlyFailed && batch.status === 'planned')
    yield* query(() =>
      db
        .update(importBatch)
        .set({ status: 'committed', committedAt: new Date() })
        .where(
          and(eq(importBatch.id, batch.id), eq(importBatch.status, 'planned')),
        ),
    )
  return run
})

// ---------------------------------------------------------------------------
// The receipt's ledger half
// ---------------------------------------------------------------------------

/** `HOLDINGS · INVESTMENTS · ROUNDS · MARKS` — what the commit landed. */
export type LedgerReceiptCounts = {
  /** Holdings the batch's events landed on. */
  holdings: number
  /** Events appended — a natural-key match reused is not counted. */
  investments: number
  rounds: number
  marks: number
  distributions: number
}

export type LedgerReceipt = {
  counts: LedgerReceiptCounts
  /** Committed events a base roll-up cannot price, by currency. */
  missingRates: Array<MissingRate>
  /** The void note, or null when the batch appended nothing to void. */
  voidLine: string | null
  /** A batch void would still reverse something. */
  voidable: boolean
  /** Every event the batch appended has been reversed (SPA-173). */
  voided: boolean
}

const committedPath = (field: string) =>
  sql.raw(`plan #>> '{ledger,committed,${field}}'`)

const appended = (field: string, kind: LedgerEventKind) =>
  sql<number>`count(*) filter (where ${committedPath(field)} is not null and not coalesce(plan #> '{ledger,committed,reused}', '[]'::jsonb) @> ${JSON.stringify([kind])}::jsonb)::int`

/**
 * The ledger receipt: the strip's counts off the committed plans, the
 * missing-rate readout (the rates `/today` reads, `rateFor`'s lookup), and
 * what a batch void would reverse — the investments, marks and
 * distributions stamped with the batch id, never its rounds.
 */
export const loadLedgerReceiptProgram = Effect.fn('loadLedgerReceiptProgram')(
  function* (batchId: string): Effect.fn.Return<LedgerReceipt, ImportFailed> {
    const inBatch = eq(importRow.batchId, batchId)
    const tally = yield* query(() =>
      db
        .select({
          holdings: sql<number>`count(distinct ${committedPath('holdingId')})::int`,
          investments: appended('investmentId', 'investment'),
          rounds: appended('roundId', 'round'),
          marks: appended('markId', 'mark'),
          distributions: appended('distributionId', 'distribution'),
        })
        .from(importRow)
        .where(inBatch)
        .then(
          (r) =>
            r.at(0) ?? {
              holdings: 0,
              investments: 0,
              rounds: 0,
              marks: 0,
              distributions: 0,
            },
        ),
    )
    // Every committed event's currency and date, grouped — the cheque, the
    // mark and the proceeds, as the roll-up would try to price them.
    const priced = yield* query(() =>
      db.execute<{ currency: string; date: string; n: number }>(sql`
        select e ->> 'currency' as currency, e ->> 'date' as date, count(*)::int as n
          from ${importRow},
               lateral (values
                 (plan #> '{ledger,events,investment}'),
                 (case when plan #> '{ledger,committed,markId}' is not null
                       then plan #> '{ledger,events,mark}' end),
                 (case when plan #> '{ledger,committed,distributionId}' is not null
                       then plan #> '{ledger,events,distribution}' end)
               ) as v(e)
         where ${importRow.batchId} = ${batchId}
           and plan #> '{ledger,committed}' is not null
           and e is not null
         group by 1, 2`),
    )
    const [base, rates] = yield* query(() =>
      Promise.all([baseCurrency(), loadFxRates()]),
    )
    const live = (table: 'investment' | 'mark' | 'distribution') =>
      sql<number>`(select count(*)::int from ${sql.identifier(table)} t where t.batch_id = ${batchId} and t.reverses_id is null)`
    const voided = (table: 'investment' | 'mark' | 'distribution') =>
      sql<number>`(select count(*)::int from ${sql.identifier(table)} t where t.batch_id = ${batchId} and t.reverses_id is null and exists (select 1 from ${sql.identifier(table)} r where r.reverses_id = t.id))`
    const stamped = yield* query(() =>
      db
        .execute<{
          investments: number
          marks: number
          distributions: number
          voided: number
        }>(
          sql`select ${live('investment')} as investments, ${live('mark')} as marks, ${live('distribution')} as distributions, (${voided('investment')} + ${voided('mark')} + ${voided('distribution')}) as voided`,
        )
        .then(
          (r) =>
            r.rows.at(0) ?? {
              investments: 0,
              marks: 0,
              distributions: 0,
              voided: 0,
            },
        ),
    )
    const total = stamped.investments + stamped.marks + stamped.distributions
    const allVoided = total > 0 && stamped.voided >= total
    return {
      counts: tally,
      missingRates: allVoided ? [] : missingRates(priced.rows, rates, base),
      voidLine: ledgerVoidLine({ ...stamped, rounds: tally.rounds }),
      voidable: total > stamped.voided,
      voided: allVoided,
    }
  },
)
