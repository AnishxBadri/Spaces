import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { activity, entity, importBatch, importRow } from '@spaces/db/schema'
import {
  distribution,
  fxRate,
  holding,
  investment,
  mark,
  round,
} from '@spaces/db/schema/portfolio'
import { holdingMetrics } from '@spaces/core/portfolio/metrics'
import { readGrid } from '@spaces/core/import/read'
import { isLedgerPlan } from '@spaces/core/import/ledger'
import { enqueued } from '#/test/queue-stub'
import { truncateAndReseed } from '#/test/reseed'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { effectFn } from '#/lib/server/effect'
import { loadHoldingDetail, loadHoldingEvents } from '#/lib/portfolio/detail'
import { addInvestmentProgram, addMarkProgram } from '#/lib/portfolio/write'
import { voidLedgerBatchProgram } from '#/lib/portfolio/reverse'
import { beginLedgerMappingProgram, planLedgerImportProgram } from './ledger'
import {
  commitImportProgram,
  loadImportReceiptProgram,
  requestCommitProgram,
} from './commit'
import { dataRowsOf } from './stage'
import type { LedgerRowPlan } from '@spaces/core/import/ledger'

/**
 * Ledger commit (SPA-171) against the database. The demo sheet is the file
 * the orchestrator uploads — `fixtures/portfolio-tracker.csv`, read through
 * the real reader — staged straight into the tables and planned by the real
 * ledger preview, then committed through `commitImportProgram`, the
 * `import.commit` job's body. Counts are read from the four event tables
 * and `holding`, so "a re-run appends nothing" is asserted, not inferred.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const ME = FIXTURE_ACTOR.id

// Per-test isolation: every test commits the same sheet, and a second
// commit of it into a database that already holds its events is the
// natural-key reuse one test asserts on purpose.
beforeEach(async () => {
  enqueued.length = 0
  await truncateAndReseed()
})

const FIXTURE = new URL('./fixtures/portfolio-tracker.csv', import.meta.url)

function demoSheet(): { header: Array<string>; rows: Array<Array<string>> } {
  const sheet = readGrid(readFileSync(FIXTURE), 'portfolio-tracker.csv')
    .sheets[0]
  const header = sheet.headerRow === null ? null : sheet.rows[sheet.headerRow]
  if (!header) throw new Error('the fixture has no header')
  return { header, rows: dataRowsOf(sheet) }
}

async function plannedLedger(
  header: Array<string>,
  rows: Array<Array<string>>,
): Promise<string> {
  const inserted = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'e'.repeat(64),
        filename: 'portfolio-tracker.csv',
        sizeBytes: 100,
        sheet: 'portfolio-tracker',
        sheets: ['portfolio-tracker'],
        headerRow: 0,
        header,
        mode: 'ledger',
        targetObjectId: null,
        rowCount: rows.length,
        createdBy: ME,
      })
      .returning({ id: importBatch.id })
  ).at(0)
  if (!inserted) throw new Error('batch insert returned no row')
  await db
    .insert(importRow)
    .values(
      rows.map((cells, i) => ({ batchId: inserted.id, rowNum: i + 1, cells })),
    )
  await Effect.runPromise(beginLedgerMappingProgram(inserted.id))
  await Effect.runPromise(planLedgerImportProgram(inserted.id))
  return inserted.id
}

async function demoBatch(): Promise<string> {
  const { header, rows } = demoSheet()
  return plannedLedger(header, rows)
}

const commit = (batchId: string, onlyFailed = false) =>
  Effect.runPromise(commitImportProgram({ batchId, userId: ME, onlyFailed }))

const receipt = async (batchId: string) => {
  const view = await Effect.runPromise(
    loadImportReceiptProgram({ batchId, filter: 'all' }),
  )
  if (!view?.ledger) throw new Error('no ledger receipt')
  return { view, ledger: view.ledger }
}

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of [
    'round',
    'investment',
    'mark',
    'distribution',
    'holding',
    'entity',
  ])
    out[t] = (
      await db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(t)}`,
      )
    ).rows[0].n
  return out
}

async function rowsOf(batchId: string) {
  return db
    .select({
      rowNum: importRow.rowNum,
      entityId: importRow.entityId,
      error: importRow.error,
      plan: importRow.plan,
    })
    .from(importRow)
    .where(eq(importRow.batchId, batchId))
    .orderBy(asc(importRow.rowNum))
}

async function ledgerPlanOf(
  batchId: string,
  rowNum: number,
): Promise<LedgerRowPlan> {
  const plan = (await rowsOf(batchId)).find((r) => r.rowNum === rowNum)?.plan
  if (!plan || !isLedgerPlan(plan)) throw new Error(`row ${rowNum}: no plan`)
  return plan
}

async function holdingOf(name: string) {
  const row = (
    await db
      .select({ id: holding.id, openedAt: holding.openedAt })
      .from(holding)
      .innerJoin(entity, eq(entity.id, holding.companyId))
      .where(eq(entity.canonicalName, name))
  ).at(0)
  if (!row) throw new Error(`no holding for ${name}`)
  return row
}

describe('the demo sheet', () => {
  it('commits twelve rows into holdings, rounds, investments and marks, and /portfolio reads them', async () => {
    const batchId = await demoBatch()
    const before = await tableCounts()
    const run = await commit(batchId)
    expect(run).toEqual({ written: 12, attached: 0, failed: 0, unchanged: 0 })

    const after = await tableCounts()
    expect(after.holding - before.holding).toBe(11)
    expect(after.investment - before.investment).toBe(12)
    expect(after.round - before.round).toBe(9)
    expect(after.mark - before.mark).toBe(8)
    expect(after.distribution - before.distribution).toBe(0)
    expect((await rowsOf(batchId)).every((r) => r.error === null)).toBe(true)

    // Every event appended carries the batch id.
    for (const table of [investment, mark, distribution]) {
      const stray = await db
        .select({ id: table.id })
        .from(table)
        .where(sql`${table.batchId} is distinct from ${batchId}`)
      expect(stray).toEqual([])
    }

    // One company's detail: the Seed round, our cheque, the 2025 mark.
    const pixxel = await holdingOf('Pixxel')
    expect(pixxel.openedAt).toBe('2023-03-15')
    const detail = await loadHoldingDetail(pixxel.id)
    expect(detail.rounds.map((r) => [r.kind, r.date])).toEqual([
      ['Seed', '2023-03-15'],
    ])
    expect(detail.investments.map((i) => [i.date, i.amount])).toEqual([
      ['2023-03-15', 50000],
    ])
    expect(detail.marks.map((m) => [m.date, m.fairValue])).toEqual([
      ['2025-12-31', 120000],
    ])
    if (!detail.metrics.ok) throw new Error('Pixxel is USD and needs no rate')
    expect(detail.metrics.metrics.costBasis).toBe(50000)
    expect(detail.metrics.metrics.unrealized).toBe(120000)
    expect(detail.metrics.metrics.moic).toBeCloseTo(2.4)

    // Two rows for one company: one holding, opened on its earliest cheque,
    // the follow-on landing on it.
    const zepto = await holdingOf('Zepto')
    expect(zepto.openedAt).toBe('2021-07-01')
    const zeptoEvents = (await loadHoldingEvents([zepto.id])).get(zepto.id)
    expect(zeptoEvents?.events.investments.map((i) => i.amount)).toEqual([
      40000, 20000,
    ])

    // The outcome lane names what the row appended and links the holding.
    const { view, ledger } = await receipt(batchId)
    expect(ledger.counts).toEqual({
      holdings: 11,
      investments: 12,
      rounds: 9,
      marks: 8,
      distributions: 0,
    })
    const row1 = view.rows.find((r) => r.rowNum === 1)
    expect(row1?.outcome).toMatchObject({
      kind: 'appended',
      parts: [
        'holding born',
        'round Seed',
        'investment $50,000',
        'mark $120,000',
      ],
    })
    expect(row1?.record).toEqual({
      name: 'Pixxel',
      href: `/portfolio/${pixxel.id}`,
    })
    // The follow-on births nothing.
    const row8 = view.rows.find((r) => r.rowNum === 8)
    expect(row8?.outcome).toMatchObject({
      kind: 'appended',
      parts: ['round Series C', 'investment $20,000'],
    })
  })

  it('a committed batch commits again and appends nothing', async () => {
    const batchId = await demoBatch()
    await commit(batchId)
    const before = await tableCounts()
    expect(await commit(batchId)).toEqual({
      written: 0,
      attached: 0,
      failed: 0,
      unchanged: 12,
    })
    expect(await tableCounts()).toEqual(before)
  })

  it('the same sheet uploaded again reuses every event by its natural key', async () => {
    const first = await demoBatch()
    await commit(first)
    const before = await tableCounts()
    const second = await demoBatch()
    expect(await commit(second)).toMatchObject({ written: 12, failed: 0 })
    expect(await tableCounts()).toEqual(before)
    const plan = await ledgerPlanOf(second, 1)
    expect(plan.ledger.committed?.reused).toEqual([
      'round',
      'investment',
      'mark',
    ])
    expect((await receipt(second)).ledger.counts).toMatchObject({
      investments: 0,
      rounds: 0,
      marks: 0,
    })
  })

  it('the Commit button enqueues a ledger batch keyed by its id', async () => {
    const batchId = await demoBatch()
    await expect(
      Effect.runPromise(
        requestCommitProgram({ batchId, userId: ME, onlyFailed: false }),
      ),
    ).resolves.toEqual({ queued: true })
    expect(enqueued.at(0)?.options?.singletonKey).toBe(batchId)
  })
})

describe('missing FX rates', () => {
  it('rows in a currency with no rate commit, are counted by currency, and are never priced at 1.0', async () => {
    // A JPY rate after the cheque and before the mark: the mark is priced,
    // the cheque is not. AED has no rate at all.
    await db
      .insert(fxRate)
      .values({ currency: 'JPY', date: '2025-01-01', rateToBase: '0.0067' })
    const batchId = await demoBatch()
    await commit(batchId)
    const rows = await rowsOf(batchId)
    expect(rows.filter((r) => r.error !== null)).toEqual([])

    const { ledger } = await receipt(batchId)
    expect(ledger.missingRates).toEqual([
      { currency: 'AED', events: 2, earliest: '2022-04-10' },
      { currency: 'JPY', events: 1, earliest: '2024-02-01' },
    ])

    const sakana = await holdingOf('Sakana AI')
    const loaded = (await loadHoldingEvents([sakana.id])).get(sakana.id)
    if (!loaded) throw new Error('no events')
    const inBase = holdingMetrics(loaded.events, {
      baseCurrency: 'USD',
      fxRates: [],
      reportIn: 'base',
    })
    expect(inBase.ok).toBe(false)
    if (inBase.ok) return
    expect(inBase.missingRates.map((m) => m.currency)).toContain('JPY')
    // Stored in its own currency, as the sheet said.
    const cheque = (
      await db
        .select({ amount: investment.amount, currency: investment.currency })
        .from(investment)
        .where(eq(investment.holdingId, sakana.id))
    ).at(0)
    expect(cheque).toEqual({ amount: '7500000.0000', currency: 'JPY' })
  })
})

describe('one writer', () => {
  it('a cheque and a mark through the server fns’ path and through the importer land identical rows', async () => {
    const byHand = await resolveEntity({
      kind: 'company',
      name: 'Hand Co',
      source: { class: 'manual' },
    })
    // `addInvestment`'s and `addMark`'s handlers below `requireUser`, exactly.
    const cheque = await effectFn(addInvestmentProgram)({
      companyId: byHand.entityId,
      date: '2024-05-01',
      amount: 50000,
      currency: 'USD',
      instrument: 'priced',
      vehicle: 'Fund I',
      actorId: ME,
    })
    await effectFn(addMarkProgram)({
      holdingId: cheque.holdingId,
      date: '2025-12-31',
      fairValue: 90000,
      currency: 'USD',
      basis: 'manual',
      actorId: ME,
    })

    const batchId = await plannedLedger(
      [
        'Company',
        'Date',
        'Amount',
        'Currency',
        'Instrument',
        'Vehicle',
        'Current value',
        'Mark date',
      ],
      [
        [
          'Sheet Co',
          '2024-05-01',
          '50000',
          'USD',
          'Priced',
          'Fund I',
          '90000',
          '2025-12-31',
        ],
      ],
    )
    await commit(batchId)
    const imported = await ledgerPlanOf(batchId, 1)
    const committed = imported.ledger.committed
    if (!committed) throw new Error('the row did not commit')

    // Identical modulo id, holding, timestamp and batch id.
    const strip = <
      T extends {
        id: string
        holdingId: string
        createdAt: Date
        batchId: string | null
      },
    >(
      row: T | undefined,
    ) => {
      if (!row) throw new Error('row missing')
      const {
        id: _id,
        holdingId: _h,
        createdAt: _c,
        batchId: stamp,
        ...rest
      } = row
      return { rest, stamp }
    }
    const inv = (id: string) =>
      db
        .select()
        .from(investment)
        .where(eq(investment.id, id))
        .then((r) => r.at(0))
    const mk = (holdingId: string) =>
      db
        .select()
        .from(mark)
        .where(eq(mark.holdingId, holdingId))
        .then((r) => r.at(0))
    const hand = strip(await inv(cheque.id))
    const sheet = strip(await inv(committed.investmentId))
    expect(sheet.rest).toEqual(hand.rest)
    expect(hand.stamp).toBeNull()
    expect(sheet.stamp).toBe(batchId)
    expect(strip(await mk(committed.holdingId)).rest).toEqual(
      strip(await mk(cheque.holdingId)).rest,
    )

    // The holding and the activity lines are the same writes too.
    const holdings = await db
      .select({ openedAt: holding.openedAt, createdBy: holding.createdBy })
      .from(holding)
      .where(inArray(holding.id, [cheque.holdingId, committed.holdingId]))
    expect(holdings).toEqual([
      { openedAt: '2024-05-01', createdBy: ME },
      { openedAt: '2024-05-01', createdBy: ME },
    ])
    const verbs = async (companyId: string) =>
      (
        await db
          .select({ verb: activity.verb })
          .from(activity)
          .where(eq(activity.subjectEntityId, companyId))
      )
        .map((a) => a.verb)
        .filter((v) => /^(holding|investment|mark)\./.test(v))
        .sort()
    const sheetCo = (await rowsOf(batchId)).at(0)?.entityId
    if (!sheetCo) throw new Error('no company')
    expect(await verbs(sheetCo)).toEqual(await verbs(byHand.entityId))
  })

  it('the server fns write through the programs and nothing else', () => {
    const source = readFileSync(
      new URL('../server/portfolio.ts', import.meta.url),
      'utf8',
    )
    for (const program of [
      'addRoundProgram',
      'addInvestmentProgram',
      'addMarkProgram',
      'addDistributionProgram',
    ])
      expect(source).toContain(`effectFn(${program})`)
    expect(source).not.toMatch(
      /\.insert\(\s*(round|investment|mark|distribution)\s*\)/,
    )
  })
})

/** An UPDATE or DELETE against one of the four event tables, in source. */
const EVENT_TABLE_WRITE = new RegExp(
  [
    // drizzle: `.update(investment)`, `.delete(mark)`
    String.raw`\.(update|delete)\(\s*(round|investment|mark|distribution)\b`,
    // raw SQL: `update investment`, `delete from "mark"`
    String.raw`\b(update|delete\s+from)\s+"?(round|investment|mark|distribution)"?\b`,
    // raw SQL through an identifier: `update ${sql.identifier(...)}`
    String.raw`\b(update|delete\s+from)\s+\$\{\s*(sql\.identifier|round|investment|mark|distribution)`,
  ].join('|'),
  'i',
)

describe('nothing overwritten', () => {
  it('the check itself catches an UPDATE and a DELETE', () => {
    expect(EVENT_TABLE_WRITE.test('tx.update(investment).set({})')).toBe(true)
    expect(EVENT_TABLE_WRITE.test('db.delete(mark).where(x)')).toBe(true)
    expect(EVENT_TABLE_WRITE.test('sql`delete from "round" where`')).toBe(true)
    expect(EVENT_TABLE_WRITE.test('sql`update ${sql.identifier(t)} set`')).toBe(
      true,
    )
    expect(EVENT_TABLE_WRITE.test('tx.update(importRow).set({})')).toBe(false)
  })

  it('no UPDATE or DELETE against round, investment, mark or distribution anywhere in the import path', () => {
    for (const file of [
      './ledger-commit.ts',
      './commit.ts',
      './ledger.ts',
      '../portfolio/write.ts',
      '../portfolio/holding.ts',
      '../../worker/jobs/import-commit.ts',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source.match(EVENT_TABLE_WRITE), file).toBeNull()
    }
  })
})

describe('a failed row', () => {
  it('rolls back alone, names the company, and Retry failed rows lands it', async () => {
    const batchId = await demoBatch()
    // Sarvam's cheque in a currency the column cannot hold: the insert
    // fails after its company, round and holding were written.
    const good = await ledgerPlanOf(batchId, 3)
    const events = good.ledger.events
    if (!events) throw new Error('Sarvam lands')
    const broken: LedgerRowPlan = {
      ...good,
      ledger: {
        ...good.ledger,
        events: {
          ...events,
          investment: { ...events.investment, currency: 'DOLLARS' },
        },
      },
    }
    await db
      .update(importRow)
      .set({ plan: broken })
      .where(and(eq(importRow.batchId, batchId), eq(importRow.rowNum, 3)))

    const before = await tableCounts()
    expect(await commit(batchId)).toMatchObject({ written: 11, failed: 1 })
    const after = await tableCounts()
    expect(after.investment - before.investment).toBe(11)
    expect(after.round - before.round).toBe(8)
    expect(after.holding - before.holding).toBe(10)
    const failed = (await rowsOf(batchId)).find((r) => r.rowNum === 3)
    expect(failed?.entityId).toBeNull()
    expect(failed?.error).toMatch(/^Sarvam · /)
    const sarvam = await db
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.canonicalName, 'Sarvam'))
    expect(sarvam).toEqual([])

    // Fixed, and retried alone: the other rows write nothing again.
    await db
      .update(importRow)
      .set({ plan: good })
      .where(and(eq(importRow.batchId, batchId), eq(importRow.rowNum, 3)))
    expect(await commit(batchId, true)).toMatchObject({
      written: 1,
      failed: 0,
      unchanged: 11,
    })
    const fixed = await tableCounts()
    expect(fixed.investment - after.investment).toBe(1)
    expect(fixed.round - after.round).toBe(1)
    expect(fixed.mark - after.mark).toBe(1)
  })
})

describe('voiding the batch', () => {
  it('voids every investment, mark and distribution it appended and nothing else; its rounds stay', async () => {
    // A position entered by hand, before the import — never the batch's.
    const other = await resolveEntity({
      kind: 'company',
      name: 'Manual Co',
      source: { class: 'manual' },
    })
    const manual = await effectFn(addInvestmentProgram)({
      companyId: other.entityId,
      date: '2022-01-01',
      amount: 1000,
      currency: 'USD',
      instrument: 'priced',
      actorId: ME,
    })
    const batchId = await demoBatch()
    await commit(batchId)
    const before = await tableCounts()
    expect((await receipt(batchId)).ledger.voidLine).toBe(
      'void reaches 12 investments · 8 marks · 9 rounds stay',
    )
    expect((await receipt(batchId)).ledger.voided).toBe(false)

    const out = await Effect.runPromise(voidLedgerBatchProgram(ME, batchId))
    expect(out.reversed).toBe(20)

    const after = await tableCounts()
    expect(after.round).toBe(before.round)
    expect(after.investment - before.investment).toBe(12)
    expect(after.mark - before.mark).toBe(8)

    // Every appended event is reversed; the hand-entered cheque is not.
    for (const table of [investment, mark]) {
      const unvoided = await db
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            eq(table.batchId, batchId),
            isNull(table.reversesId),
            sql`not exists (select 1 from ${table} r where r.reverses_id = ${table.id})`,
          ),
        )
      expect(unvoided).toEqual([])
    }
    const manualReversal = await db
      .select({ id: investment.id })
      .from(investment)
      .where(eq(investment.reversesId, manual.id))
    expect(manualReversal).toEqual([])

    // The holdings read as before the import: nothing live on them.
    const pixxel = await holdingOf('Pixxel')
    const detail = await loadHoldingDetail(pixxel.id)
    if (!detail.metrics.ok) throw new Error('metrics')
    expect(detail.metrics.metrics.costBasis).toBe(0)
    expect(detail.investments.map((i) => i.reversesId !== null)).toEqual([
      false,
      true,
    ])
    const { ledger } = await receipt(batchId)
    expect(ledger.voidLine).toBe(
      'voided · 12 investments · 8 marks reversed · 9 rounds stay',
    )
    expect(ledger.voidable).toBe(false)
    expect(ledger.voided).toBe(true)
    expect(ledger.missingRates).toEqual([])
    // Rounds carry no batch id; the receipt still names them.
    expect(ledger.counts.rounds).toBe(9)
    expect(await db.select({ id: round.id }).from(round)).toHaveLength(9)
  })
})
