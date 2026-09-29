import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { attribute, importBatch, importRow, objectDef } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { createAttributeProgram } from '@spaces/core/writes/attributes/create'
import { createObjectProgram } from '@spaces/core/writes/attributes/object-registry'
import {
  beginImportMappingProgram,
  createImportAttributeProgram,
  loadImportMappingProgram,
  mapImportColumnProgram,
  mappingMessage,
} from './mapping'
import { defineImportBatchProgram, loadImportBatchProgram } from './stage'
import type { ImportMappingView } from './mapping'

/**
 * Column mapping (SPA-165). The mapping is generated from the registry, lives
 * on the batch row, and reads every staged row for the parse count its head
 * shows. Batches are inserted directly: staging is SPA-164's and its tests
 * cover it; this file needs rows, not bytes.
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

async function attributeId(object: string, slug: string): Promise<string> {
  const row = (
    await db
      .select({ id: attribute.id })
      .from(attribute)
      .where(and(eq(attribute.objectId, object), eq(attribute.slug, slug)))
  ).at(0)
  if (!row) throw new Error(`attribute ${slug} missing`)
  return row.id
}

/** A staged records batch with its rows, straight into the tables. */
async function batchOf(
  header: Array<string>,
  rows: Array<Array<string>>,
  targetObjectId: string | null,
): Promise<string> {
  const inserted = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'f'.repeat(64),
        filename: 'sheet.csv',
        sizeBytes: 100,
        sheet: 'sheet',
        sheets: ['sheet'],
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
  return inserted.id
}

async function view(batchId: string): Promise<ImportMappingView> {
  const out = await Effect.runPromise(loadImportMappingProgram(batchId))
  if (!out) throw new Error('batch is not on the mapping step')
  return out
}

const refusalOf = async <TValue, TError>(
  program: Effect.Effect<TValue, TError>,
) => mappingMessage(await Effect.runPromise(Effect.flip(program)))

describe('the mapping is generated from the registry', () => {
  it('maps a custom object with three attributes and a declared key, with no importer code', async () => {
    const createdBy = await actorId()
    const funds = await Effect.runPromise(
      createObjectProgram({
        singular: 'Fund',
        plural: 'Funds',
        identityKeys: ['domain'],
        createdBy,
      }),
    )
    for (const [name, type, options] of [
      ['Vintage', 'number', undefined],
      ['Strategy', 'select', [{ label: 'Venture' }, { label: 'Growth' }]],
      ['Fund size', 'currency', undefined],
    ] as const) {
      await Effect.runPromise(
        createAttributeProgram({
          objectId: funds.id,
          name,
          type,
          ...(options ? { options } : {}),
          createdBy,
        }),
      )
    }
    const batchId = await batchOf(
      ['Name', 'Website', 'Vintage', 'Strategy', 'Fund size', 'Notes'],
      [
        ['Accel', 'accel.com', '2019', 'Venture', '$500,000,000', 'x'],
        ['Tiger', 'tiger.com', 'n/a', 'Buyout', '(1,000)', ''],
      ],
      funds.id,
    )
    expect(await Effect.runPromise(loadImportMappingProgram(batchId))).toBe(
      null,
    )
    await Effect.runPromise(beginImportMappingProgram(batchId))

    const v = await view(batchId)
    expect(v.object.identityKeys).toEqual(['domain'])
    // The declared key is offered once, as identity — not as its backing attribute.
    expect(v.attributes.map((a) => a.name)).toEqual([
      'Vintage',
      'Strategy',
      'Fund size',
    ])
    expect(v.mapping).toEqual([
      { target: 'name' },
      { target: 'identity', key: 'domain' },
      {
        target: 'attribute',
        attributeId: await attributeId(funds.id, 'vintage'),
      },
      {
        target: 'attribute',
        attributeId: await attributeId(funds.id, 'strategy'),
      },
      {
        target: 'attribute',
        attributeId: await attributeId(funds.id, 'fund_size'),
      },
      { target: 'ignore' },
    ])
    // Vintage: one of two parses; Strategy: "Buyout" is a choice, not a break.
    expect(v.columns[2]).toMatchObject({ parsed: 1, total: 2, status: 'fail' })
    expect(v.columns[2].failures).toEqual([
      { rowNum: 2, raw: 'n/a', reason: '"n/a" is not a number' },
    ])
    expect(v.columns[3]).toMatchObject({ parsed: 1, total: 2, status: 'warn' })
    expect(v.columns[5]).toMatchObject({ parsed: null, status: null })
    expect(v.problems).toEqual([])
  })
})

describe('the mapping lives on the batch', () => {
  it('survives a reload, and the step is read off the row', async () => {
    const deals = await objectId('deals')
    const batchId = await batchOf(
      ['Deal', 'Stage', 'Amount'],
      [['Acme seed', 'Screening', '$1,250']],
      deals,
    )
    await Effect.runPromise(beginImportMappingProgram(batchId))
    await Effect.runPromise(
      mapImportColumnProgram({
        batchId,
        column: 0,
        target: { target: 'name' },
      }),
    )
    const batch = await Effect.runPromise(loadImportBatchProgram(batchId))
    expect(batch.mapping?.at(0)).toEqual({ target: 'name' })
    expect((await view(batchId)).mapping.at(0)).toEqual({ target: 'name' })

    // A second Continue keeps what the operator chose.
    await Effect.runPromise(beginImportMappingProgram(batchId))
    expect((await view(batchId)).mapping.at(0)).toEqual({ target: 'name' })

    // Choosing another object starts over, back on step 1.
    await Effect.runPromise(
      defineImportBatchProgram({
        batchId,
        mode: 'records',
        targetObjectId: await objectId('companies'),
      }),
    )
    expect(
      (await Effect.runPromise(loadImportBatchProgram(batchId))).mapping,
    ).toBe(null)
    expect(await Effect.runPromise(loadImportMappingProgram(batchId))).toBe(
      null,
    )
  })

  it('refuses the step before an object is chosen', async () => {
    const batchId = await batchOf(['Name'], [['Acme']], null)
    expect(await refusalOf(beginImportMappingProgram(batchId))).toBe(
      'Choose the object these rows go into first',
    )
  })
})

describe('one column, one target', () => {
  it('clears the first column when a second takes its attribute, and names it', async () => {
    const deals = await objectId('deals')
    const stage = await attributeId(deals, 'stage')
    const batchId = await batchOf(
      ['Stage', 'Round'],
      [['Screening', 'Seed']],
      deals,
    )
    await Effect.runPromise(beginImportMappingProgram(batchId))
    expect((await view(batchId)).mapping.at(0)).toEqual({
      target: 'attribute',
      attributeId: stage,
    })
    const out = await Effect.runPromise(
      mapImportColumnProgram({
        batchId,
        column: 1,
        target: { target: 'attribute', attributeId: stage },
      }),
    )
    expect(out.replaced).toEqual([
      { column: 0, previous: { target: 'attribute', attributeId: stage } },
    ])
    expect((await view(batchId)).mapping).toEqual([
      { target: 'ignore' },
      { target: 'attribute', attributeId: stage },
    ])
  })

  it('refuses a mapping with no name before the step advances, and one where nothing parses', async () => {
    const deals = await objectId('deals')
    const batchId = await batchOf(
      ['Deal', 'Amount', 'Stage'],
      [
        ['A', '$1,250', 'Seed'],
        ['B', '(400)', 'Screening'],
        ['C', 'TBD', ''],
      ],
      deals,
    )
    await Effect.runPromise(beginImportMappingProgram(batchId))
    const value = await attributeId(deals, 'value')
    await Effect.runPromise(
      mapImportColumnProgram({
        batchId,
        column: 1,
        target: { target: 'attribute', attributeId: value },
      }),
    )
    let v = await view(batchId)
    expect(v.problems.map((p) => p.reason)).toEqual([
      'Map one column to the name',
    ])
    // $1,250 and (400) parse, TBD does not.
    expect(v.columns[1]).toMatchObject({
      parsed: 2,
      total: 3,
      failureCount: 1,
      status: 'fail',
    })
    expect(v.columns[1].failures.at(0)?.rowNum).toBe(3)
    // "Seed" is no stage: a choice for the operator, never an invented option.
    expect(v.columns[2]).toMatchObject({ parsed: 1, total: 2, status: 'warn' })

    // A column where nothing parses is called out by name.
    await Effect.runPromise(
      mapImportColumnProgram({
        batchId,
        column: 0,
        target: { target: 'name' },
      }),
    )
    await Effect.runPromise(
      mapImportColumnProgram({
        batchId,
        column: 2,
        target: { target: 'attribute', attributeId: value },
      }),
    )
    v = await view(batchId)
    expect(v.problems.map((p) => p.reason)).toEqual([
      'Nothing in C · Stage parses — map it elsewhere or skip it',
    ])
  })

  it('refuses a target the object does not offer', async () => {
    const deals = await objectId('deals')
    const batchId = await batchOf(['Company'], [['Acme']], deals)
    await Effect.runPromise(beginImportMappingProgram(batchId))
    const value = await attributeId(deals, 'value')
    expect(
      await refusalOf(
        mapImportColumnProgram({
          batchId,
          column: 0,
          target: {
            target: 'attribute',
            attributeId: value,
            createMissing: true,
          },
        }),
      ),
    ).toBe('Create missing belongs to a record reference column')
    expect(
      await refusalOf(
        mapImportColumnProgram({
          batchId,
          column: 0,
          target: { target: 'identity', key: 'domain' },
        }),
      ),
    ).toBe('domain does not identify these records')
    expect(
      await refusalOf(
        mapImportColumnProgram({
          batchId,
          column: 4,
          target: { target: 'ignore' },
        }),
      ),
    ).toBe('That column is not in the sheet')
  })
})

describe('+ New attribute', () => {
  it('creates through the attribute-create program and maps the column', async () => {
    const companies = await objectId('companies')
    const batchId = await batchOf(
      ['Name', 'Sector'],
      [
        ['Acme', 'Fintech'],
        ['Globex', 'fintech'],
        ['Initech', 'Health'],
      ],
      companies,
    )
    await Effect.runPromise(beginImportMappingProgram(batchId))
    // Choosing a type stores a draft; nothing is written to the registry yet.
    await Effect.runPromise(
      mapImportColumnProgram({
        batchId,
        column: 1,
        target: {
          target: 'new',
          name: 'Sector',
          type: 'select',
          options: ['Fintech', 'Health'],
        },
      }),
    )
    let v = await view(batchId)
    expect(v.columns[1].labels.select).toEqual(['Fintech', 'Health'])
    expect(v.columns[1]).toMatchObject({ parsed: 3, total: 3 })
    expect(v.problems.map((p) => p.column)).toEqual([1])
    const before = await db
      .select({ id: attribute.id })
      .from(attribute)
      .where(
        and(eq(attribute.objectId, companies), eq(attribute.slug, 'sector')),
      )
    expect(before).toEqual([])

    const out = await Effect.runPromise(
      createImportAttributeProgram({
        batchId,
        column: 1,
        name: 'Sector',
        type: 'select',
        options: ['Fintech', 'Health'],
        dateOrder: null,
        userId: await actorId(),
      }),
    )
    const created = (
      await db.select().from(attribute).where(eq(attribute.id, out.attributeId))
    ).at(0)
    expect(created).toMatchObject({
      objectId: companies,
      slug: 'sector',
      type: 'select',
    })
    expect(created?.options.options?.map((o) => o.label)).toEqual([
      'Fintech',
      'Health',
    ])
    v = await view(batchId)
    expect(v.mapping.at(1)).toEqual({
      target: 'attribute',
      attributeId: out.attributeId,
    })
    expect(v.attributes.some((a) => a.id === out.attributeId)).toBe(true)
    expect(v.problems).toEqual([])
  })

  it('carries the declared date order of a new date column', async () => {
    const deals = await objectId('deals')
    const batchId = await batchOf(
      ['Deal', 'Signed'],
      [['A', '03/04/2026']],
      deals,
    )
    await Effect.runPromise(beginImportMappingProgram(batchId))
    const out = await Effect.runPromise(
      createImportAttributeProgram({
        batchId,
        column: 1,
        name: 'Signed on',
        type: 'date',
        options: [],
        dateOrder: 'dmy',
        userId: await actorId(),
      }),
    )
    const v = await view(batchId)
    expect(v.mapping.at(1)).toEqual({
      target: 'attribute',
      attributeId: out.attributeId,
      dateOrder: 'dmy',
    })
    expect(v.columns[1]).toMatchObject({ parsed: 1, total: 1, status: 'ok' })
  })

  it("passes the create program's refusal through", async () => {
    const deals = await objectId('deals')
    const batchId = await batchOf(['Deal', 'Tier'], [['A', '']], deals)
    await Effect.runPromise(beginImportMappingProgram(batchId))
    expect(
      await refusalOf(
        createImportAttributeProgram({
          batchId,
          column: 1,
          name: 'Tier',
          type: 'select',
          options: [],
          dateOrder: null,
          userId: await actorId(),
        }),
      ),
    ).toBe('Give at least one option')
  })
})
