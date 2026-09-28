import { Effect } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { holding, importBatch, importRow } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { isLedgerPlan } from '@spaces/core/import/ledger'
import {
  UNIVERSAL_HEADER,
  UNIVERSAL_ROWS,
} from '@spaces/core/import/ledger.fixtures'
import { resolveEntity } from '#/lib/entities/resolve'
import {
  beginLedgerMappingProgram,
  decideLedgerRowProgram,
  ledgerMessage,
  loadLedgerImportProgram,
  mapLedgerFieldProgram,
  planLedgerImportProgram,
  setLedgerDecisionProgram,
} from './ledger'
import { reopenImportMappingProgram } from './plan'

/**
 * Ledger mapping (SPA-170) against the database: the company column goes
 * through the reference matcher, holdings already held are read, plans are
 * stored — and nothing reaches `round`, `investment`, `mark`,
 * `distribution`, `holding` or `entity`.
 */

async function actorId(): Promise<string> {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('fixture user missing')
  return row.id
}

/** The demo sheet: twelve rows, row 4's instrument a bare `SAFE`. */
function demoRows(): Array<Array<string>> {
  return UNIVERSAL_ROWS.map((cells, i) => {
    const out = [...cells]
    if (i === 3) out[4] = 'SAFE'
    return out
  })
}

async function ledgerBatch(
  header: Array<string>,
  rows: Array<Array<string>>,
): Promise<string> {
  const inserted = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'f'.repeat(64),
        filename: 'portfolio-tracker.xlsx',
        sizeBytes: 100,
        sheet: 'Holdings',
        sheets: ['Holdings'],
        headerRow: 0,
        header,
        mode: 'ledger',
        targetObjectId: null,
        rowCount: rows.length,
        createdBy: await actorId(),
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
  return inserted.id
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
  ]) {
    const r = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier(t)}`,
    )
    out[t] = r.rows[0].n
  }
  return out
}

const run = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(effect)

async function view(batchId: string) {
  const v = await run(loadLedgerImportProgram(batchId))
  if (!v) throw new Error('not a ledger batch')
  return v
}

describe('the ledger demo', () => {
  it('maps a 12-row sheet, reports per company, errors on SAFE and writes nothing', async () => {
    const pixxel = await resolveEntity({
      kind: 'company',
      name: 'Pixxel',
      source: { class: 'manual' },
    })
    const before = await tableCounts()
    const batchId = await ledgerBatch(UNIVERSAL_HEADER, demoRows())

    const mapping = (await view(batchId)).mapping
    expect(mapping?.problems).toEqual([])
    expect(mapping?.companies).toMatchObject({ found: 1, missing: 10 })
    expect(
      mapping?.summary.instruments.find((v) => v.raw === 'SAFE')?.resolution,
    ).toBeNull()
    expect(mapping?.counts).toMatchObject({ investments: 11, noLand: 1 })

    const out = await run(planLedgerImportProgram(batchId))
    expect(out.counts).toMatchObject({
      holdings: 10,
      investments: 11,
      noLand: 1,
      needDecision: 1,
    })

    const preview = (await view(batchId)).preview
    if (!preview) throw new Error('no preview')
    const px = preview.companies.find((c) => c.name === 'Pixxel')
    expect(px?.verdict).toBe('attach')
    expect(px?.entityId).toBe(pixxel.entityId)
    expect(px?.holding).toBe('birth')
    expect(px?.events.map((e) => e.text)).toEqual([
      'round Seed 2023-03-15',
      'investment $50,000 priced',
      'round Series B 2024-06-20',
      'investment $30,000 priced',
      'mark $120,000 2025-12-31',
    ])
    expect(preview.failed).toHaveLength(1)
    expect(preview.failed[0]).toMatchObject({ rowNum: 4, name: 'Kalpa' })
    expect(preview.failed[0].why).toContain('safe_post_money')
    expect(preview.failed[0].why).toContain('safe_pre_money')

    // Nothing reached the ledger, the holdings or the graph.
    expect(await tableCounts()).toEqual(before)
  })

  it('a company that already holds a position births no second holding', async () => {
    const zepto = await resolveEntity({
      kind: 'company',
      name: 'Zepto',
      source: { class: 'manual' },
    })
    await db
      .insert(holding)
      .values({ companyId: zepto.entityId, openedAt: '2021-07-01' })
    const batchId = await ledgerBatch(UNIVERSAL_HEADER, UNIVERSAL_ROWS)
    await run(planLedgerImportProgram(batchId))
    const rows = await db
      .select({ rowNum: importRow.rowNum, plan: importRow.plan })
      .from(importRow)
      .where(eq(importRow.batchId, batchId))
    const z = rows.find((r) => r.rowNum === 6)?.plan
    if (!z || !isLedgerPlan(z)) throw new Error('no ledger plan')
    expect(z.verdict).toBe('attach')
    expect(z.ledger.birthsHolding).toBe(false)
  })
})

describe('decisions', () => {
  it('a SAFE decided per row is chosen from the preview and re-planned there', async () => {
    const batchId = await ledgerBatch(UNIVERSAL_HEADER, demoRows())
    await run(
      setLedgerDecisionProgram({
        batchId,
        decision: { kind: 'instrument', value: 'safe', resolution: 'per_row' },
      }),
    )
    await run(planLedgerImportProgram(batchId))
    const preview = (await view(batchId)).preview
    expect(preview?.failed[0].perRow).toEqual({
      raw: 'SAFE',
      candidates: ['safe_post_money', 'safe_pre_money'],
    })
    const out = await run(
      decideLedgerRowProgram({
        batchId,
        rowNum: 4,
        instrument: 'safe_pre_money',
      }),
    )
    expect(out.counts.noLand).toBe(0)
    const after = (await view(batchId)).preview
    expect(after?.failed).toEqual([])
  })

  it('a mapping change throws the plan away, and planning twice is byte-identical', async () => {
    const batchId = await ledgerBatch(UNIVERSAL_HEADER, UNIVERSAL_ROWS)
    const snapshot = async () =>
      JSON.stringify(
        await db
          .select({ rowNum: importRow.rowNum, plan: importRow.plan })
          .from(importRow)
          .where(eq(importRow.batchId, batchId))
          .orderBy(importRow.rowNum),
      )
    await run(planLedgerImportProgram(batchId))
    const first = await snapshot()
    await run(reopenImportMappingProgram(batchId))
    expect((await view(batchId)).preview).toBeNull()
    await run(planLedgerImportProgram(batchId))
    expect(await snapshot()).toBe(first)

    // Unmapping the mark value leaves the batch staged with no plan.
    await run(
      mapLedgerFieldProgram({ batchId, field: 'markValue', column: null }),
    )
    const batch = (
      await db.select().from(importBatch).where(eq(importBatch.id, batchId))
    ).at(0)
    expect(batch?.status).toBe('staged')
    expect((await view(batchId)).mapping?.counts.marks).toBe(0)
  })

  it('refuses a mapping without the cheque amount', async () => {
    const batchId = await ledgerBatch(UNIVERSAL_HEADER, UNIVERSAL_ROWS)
    await run(mapLedgerFieldProgram({ batchId, field: 'amount', column: null }))
    const failure = await Effect.runPromise(
      Effect.flip(planLedgerImportProgram(batchId)),
    )
    expect(ledgerMessage(failure)).toBe('Map the amount of our cheque')
  })
})
