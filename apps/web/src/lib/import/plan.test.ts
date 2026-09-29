import { Effect } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { attribute, importBatch, importRow, objectDef } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { awaitingDecision, whyOf } from '@spaces/core/import/plan'
import { createObjectProgram } from '@spaces/core/writes/attributes/object-registry'
import {
  RESOLVE_NEEDS_NAME_OR_KEY,
  previewResolve,
  resolveEntity,
} from '@spaces/core/writes/entities/resolve'
import { beginImportMappingProgram, mapImportColumnProgram } from './mapping'
import {
  decideImportCollisionProgram,
  loadImportPreviewProgram,
  planImportProgram,
  planMessage,
  reopenImportMappingProgram,
} from './plan'
import type { RowPlan } from '@spaces/core/import/plan'

/**
 * Resolve preview (SPA-167). Batches are inserted straight into the tables,
 * as in `mapping.test.ts`: this file needs rows, not bytes. The graph is
 * seeded through `resolveEntity`, the door the preview must agree with.
 */

async function actorId(): Promise<string> {
  const row = (await db.select({ id: user.id }).from(user).limit(1)).at(0)
  if (!row) throw new Error('fixture user missing')
  return row.id
}

async function objectId(slug: string): Promise<string> {
  const row = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, slug))
  ).at(0)
  if (!row) throw new Error(`object ${slug} missing`)
  return row.id
}

/** A staged records batch, its rows, and the mapping step entered. */
async function mappedBatch(
  header: Array<string>,
  rows: Array<Array<string>>,
  targetObjectId: string,
): Promise<string> {
  const inserted = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'e'.repeat(64),
        filename: 'companies.csv',
        sizeBytes: 100,
        sheet: 'companies',
        sheets: ['companies'],
        headerRow: 0,
        header,
        mode: 'records',
        targetObjectId,
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
  await Effect.runPromise(beginImportMappingProgram(inserted.id))
  return inserted.id
}

async function plansOf(batchId: string): Promise<Map<number, RowPlan | null>> {
  const rows = await db
    .select({ rowNum: importRow.rowNum, plan: importRow.plan })
    .from(importRow)
    .where(eq(importRow.batchId, batchId))
  return new Map(rows.map((r) => [r.rowNum, r.plan]))
}

async function plan(batchId: string, rowNum: number): Promise<RowPlan> {
  const p = (await plansOf(batchId)).get(rowNum)
  if (!p) throw new Error(`row ${rowNum} has no plan`)
  return p
}

async function graphCounts() {
  const count = async (table: string) =>
    (
      await db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table)}`,
      )
    ).rows[0].n
  return {
    entity: await count('entity'),
    alias: await count('entity_alias'),
    candidates: await count('duplicate_candidate'),
  }
}

async function company(name: string, domain: string): Promise<string> {
  const out = await resolveEntity({
    kind: 'company',
    name,
    keys: { domain },
    source: { class: 'manual' },
  })
  return out.entityId
}

describe('previewResolve writes nothing', () => {
  it('previews 50 rows with entity, entity_alias and duplicate_candidate unchanged', async () => {
    const companies = await objectId('companies')
    const existing: Array<string> = []
    for (let i = 0; i < 12; i++)
      existing.push(await company(`Known ${i}`, `known-${i}.com`))
    // A near-name the fuzzy sweep (step 3) would pair, were it called.
    await company('Nimbus Robotics', 'nimbus-robotics.com')

    const rows: Array<Array<string>> = []
    for (let i = 0; i < 12; i++)
      rows.push([`Known ${i} Inc`, `https://www.known-${i}.com`, '2019'])
    for (let i = 0; i < 31; i++)
      rows.push([`Fresh ${i}`, `fresh-${i}.com`, '2021'])
    rows.push(['Nimbus Robotic', 'nimbus-new.com', ''])
    // A bad cell is skipped, never the row: these three still create.
    for (let i = 0; i < 3; i++)
      rows.push([`Rough ${i}`, `rough-${i}.com`, 'TBD'])
    // Neither a name nor a key: the three that will not land.
    for (let i = 0; i < 3; i++) rows.push(['', '', '2020'])
    expect(rows).toHaveLength(50)

    const batchId = await mappedBatch(
      ['Name', 'Domain', 'Founded'],
      rows,
      companies,
    )
    const before = await graphCounts()
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(await graphCounts()).toEqual(before)

    expect(counts).toMatchObject({
      create: 35,
      attach: 12,
      noLand: 3,
      cellsSkipped: 3,
      total: 50,
    })
    const status = (
      await db
        .select({ status: importBatch.status })
        .from(importBatch)
        .where(eq(importBatch.id, batchId))
    ).at(0)?.status
    expect(status).toBe('planned')

    // The report reads the same numbers the plans carry, and names the file.
    const view = await Effect.runPromise(
      loadImportPreviewProgram({ batchId, filter: 'attach' }),
    )
    expect(view?.matching).toBe(12)
    expect(view?.rows[0].plan.matchedOn).toEqual({
      kind: 'domain',
      value: 'known-0.com',
    })
    expect(view?.matched[existing[0]]).toBe('Known 0')
  })

  it('previewResolve alone inserts nothing either, across attach, create and refusal', async () => {
    await company('Orbit', 'orbit.com')
    const before = await graphCounts()
    for (let i = 0; i < 50; i++) {
      await previewResolve({
        kind: i % 2 === 0 ? 'company' : 'person',
        name: `Orbit ${i}`,
        keys: { domain: i % 3 === 0 ? 'orbit.com' : `new-${i}.com` },
      })
    }
    await previewResolve({ kind: 'company' })
    expect(await graphCounts()).toEqual(before)
  })
})

describe('attach', () => {
  it('names the matched key, and previewing twice gives the same answer', async () => {
    const id = await company('Acme', 'acme.com')
    const input = {
      kind: 'company' as const,
      name: 'Acme Corporation',
      keys: { domain: 'http://ACME.com/about' },
    }
    const first = await previewResolve(input)
    const second = await previewResolve(input)
    expect(first).toEqual({
      verdict: 'attach',
      entityId: id,
      matchedOn: { kind: 'domain', value: 'acme.com' },
    })
    expect(second).toEqual(first)
    // And the write agrees with the preview.
    const written = await resolveEntity({
      ...input,
      source: { class: 'import' },
    })
    expect(written.entityId).toBe(id)
    expect(written.matchedOn).toBe('domain')
  })
})

describe('in-file collisions', () => {
  it('same key and different names collide until a decision is stored', async () => {
    const batchId = await mappedBatch(
      ['Name', 'Domain'],
      [
        ['Acme', 'collide.io'],
        ['Beta', 'beta.com'],
        ['Acme Robotics', 'www.collide.io'],
      ],
      await objectId('companies'),
    )
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(counts).toMatchObject({ create: 1, collide: 2 })
    expect(awaitingDecision(counts)).toBe(true)
    expect((await plan(batchId, 1)).verdict).toBe('collide')
    expect((await plan(batchId, 3)).collidesWith).toEqual([1])

    const decided = await Effect.runPromise(
      decideImportCollisionProgram({
        batchId,
        rowNum: 3,
        decision: 'keep-second',
      }),
    )
    expect(decided.counts).toMatchObject({ create: 2, collide: 0, merged: 1 })
    expect(awaitingDecision(decided.counts)).toBe(false)
    expect(await plan(batchId, 1)).toMatchObject({
      verdict: 'merged',
      mergedInto: 3,
      decision: 'keep-second',
    })
    expect(await plan(batchId, 3)).toMatchObject({
      verdict: 'create',
      decision: 'keep-second',
    })
  })

  it('same key and same name merge into one planned row', async () => {
    const batchId = await mappedBatch(
      ['Name', 'Domain'],
      [
        ['Acme Inc', 'collide.io'],
        ['ACME', 'https://collide.io'],
      ],
      await objectId('companies'),
    )
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(counts).toMatchObject({ create: 1, merged: 1, collide: 0 })
    expect((await plan(batchId, 2)).mergedInto).toBe(1)
  })
})

describe('red is a cell, never a row', () => {
  it('a bad currency cell plans as create with one skipped cell and its reason', async () => {
    const deals = await objectId('deals')
    const batchId = await mappedBatch(
      ['Name', 'Raise'],
      [
        ['Acme seed', 'TBD'],
        ['Beta seed', '$250,000'],
      ],
      deals,
    )
    const value = (
      await db
        .select({ id: attribute.id })
        .from(attribute)
        .where(and(eq(attribute.objectId, deals), eq(attribute.slug, 'value')))
    ).at(0)
    if (!value) throw new Error('deal value attribute missing')
    await Effect.runPromise(
      mapImportColumnProgram({
        batchId,
        column: 1,
        target: { target: 'attribute', attributeId: value.id },
      }),
    )
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(counts).toMatchObject({ create: 2, noLand: 0, cellsSkipped: 1 })
    const rough = await plan(batchId, 1)
    expect(rough.verdict).toBe('create')
    expect(rough.patch).toEqual({})
    expect(rough.skippedCells).toEqual([
      { column: 1, raw: 'TBD', reason: 'not money' },
    ])
    expect(whyOf(rough, ['Name', 'Raise'])).toBe(
      'Raise "TBD" skipped · not money · deal birth',
    )
    expect((await plan(batchId, 2)).patch).toEqual({ [value.id]: 250000 })
  })

  it('an identity cell that does not normalise is skipped and the row creates on its name', async () => {
    const batchId = await mappedBatch(
      ['Name', 'Domain'],
      [
        ['Freemail Co', 'gmail.com'],
        ['Good Co', 'good.io'],
      ],
      await objectId('companies'),
    )
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(counts).toMatchObject({ create: 2, noLand: 0, cellsSkipped: 1 })
    const row = await plan(batchId, 1)
    expect(row.identity).toEqual({})
    expect(row.skippedCells[0]).toMatchObject({ column: 1, raw: 'gmail.com' })
  })
})

describe('refusal', () => {
  it("a row with no name and no key is resolveEntity's own refusal and the batch plans on", async () => {
    const batchId = await mappedBatch(
      ['Name', 'Domain'],
      [
        ['Acme', 'refuse.io'],
        ['', ''],
        ['', 'keyonly.com'],
      ],
      await objectId('companies'),
    )
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(counts).toMatchObject({ create: 2, noLand: 1 })
    const refused = await plan(batchId, 2)
    expect(refused.verdict).toBe('no-land')
    expect(refused.errors[0].reason).toBe(RESOLVE_NEEDS_NAME_OR_KEY)
    await expect(
      resolveEntity({ kind: 'company', source: { class: 'import' } }),
    ).rejects.toThrow(RESOLVE_NEEDS_NAME_OR_KEY)
  })
})

describe('three creators', () => {
  it('names resolveEntity, the deal birth path or createRecordProgram per object', async () => {
    const companies = await mappedBatch(
      ['Name'],
      [['Acme']],
      await objectId('companies'),
    )
    const deals = await mappedBatch(
      ['Name'],
      [['Acme seed']],
      await objectId('deals'),
    )
    const funds = await Effect.runPromise(
      createObjectProgram({
        singular: 'Fund',
        plural: 'Funds',
        identityKeys: ['domain'],
        createdBy: await actorId(),
      }),
    )
    const custom = await mappedBatch(
      ['Name', 'Domain'],
      [['Fund I', 'fund.vc']],
      funds.id,
    )
    for (const id of [companies, deals, custom])
      await Effect.runPromise(planImportProgram(id))
    expect((await plan(companies, 1)).creator).toBe('resolveEntity')
    expect((await plan(deals, 1)).creator).toBe('dealBirth')
    const fund = await plan(custom, 1)
    expect(fund.creator).toBe('createRecordProgram')
    expect(fund.identity).toEqual({ domain: 'fund.vc' })
  })
})

describe('invalidation', () => {
  it('a mapping change clears the plan, and the preview recomputes on continue', async () => {
    await company('Acme', 'invalid.io')
    const batchId = await mappedBatch(
      ['Name', 'Domain'],
      [['Acme', 'invalid.io']],
      await objectId('companies'),
    )
    await Effect.runPromise(planImportProgram(batchId))
    expect((await plan(batchId, 1)).verdict).toBe('attach')

    await Effect.runPromise(
      mapImportColumnProgram({
        batchId,
        column: 1,
        target: { target: 'ignore' },
      }),
    )
    expect((await plansOf(batchId)).get(1)).toBeNull()
    const verdict = (
      await db
        .select({ verdict: importRow.verdict })
        .from(importRow)
        .where(eq(importRow.batchId, batchId))
    ).at(0)?.verdict
    expect(verdict).toBeNull()
    expect(
      await Effect.runPromise(
        loadImportPreviewProgram({ batchId, filter: 'all' }),
      ),
    ).toBeNull()

    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(counts).toMatchObject({ create: 1, attach: 0 })
  })

  it('back to mapping discards the plan; a decision on a stale batch is refused', async () => {
    const batchId = await mappedBatch(
      ['Name', 'Domain'],
      [
        ['Acme', 'back.io'],
        ['Acme Robotics', 'back.io'],
      ],
      await objectId('companies'),
    )
    await Effect.runPromise(planImportProgram(batchId))
    await Effect.runPromise(reopenImportMappingProgram(batchId))
    expect((await plansOf(batchId)).get(1)).toBeNull()
    const refusal = await Effect.runPromise(
      Effect.flip(
        decideImportCollisionProgram({
          batchId,
          rowNum: 1,
          decision: 'skip-both',
        }),
      ),
    )
    expect(planMessage(refusal)).toMatch(/out of date/)
  })
})
