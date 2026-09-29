import { Effect } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  attribute,
  entity,
  importBatch,
  importRow,
  objectDef,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { referenceLands, whyOf } from '@spaces/core/import/plan'
import { createAttributeProgram } from '@spaces/core/writes/attributes/create'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  beginImportMappingProgram,
  loadImportMappingProgram,
  mapImportColumnProgram,
} from './mapping'
import {
  decideImportCollisionProgram,
  loadImportPreviewProgram,
  planImportProgram,
} from './plan'
import type { ColumnTarget } from '@spaces/core/import/mapping'
import type { RowPlan } from '@spaces/core/import/plan'

/**
 * Reference cells find their record (SPA-168). Batches go straight into the
 * tables, as in `plan.test.ts`; the graph is seeded through `resolveEntity`,
 * the door a reference must agree with.
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

async function batch(
  header: Array<string>,
  rows: Array<Array<string>>,
  targetObjectId: string,
): Promise<string> {
  const inserted = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'a'.repeat(64),
        filename: 'deals.csv',
        sizeBytes: 100,
        sheet: 'deals',
        sheets: ['deals'],
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

const map = (batchId: string, column: number, target: ColumnTarget) =>
  Effect.runPromise(mapImportColumnProgram({ batchId, column, target }))

/** A Deals batch: column 0 the name, the rest mapped by the header guess. */
async function dealBatch(
  header: Array<string>,
  rows: Array<Array<string>>,
): Promise<string> {
  const id = await batch(header, rows, await objectId('deals'))
  await map(id, 0, { target: 'name' })
  return id
}

async function plan(batchId: string, rowNum: number): Promise<RowPlan> {
  const p = (
    await db
      .select({ plan: importRow.plan })
      .from(importRow)
      .where(and(eq(importRow.batchId, batchId), eq(importRow.rowNum, rowNum)))
  ).at(0)?.plan
  if (!p) throw new Error(`row ${rowNum} has no plan`)
  return p
}

async function company(name: string, domain?: string): Promise<string> {
  const out = await resolveEntity({
    kind: 'company',
    name,
    ...(domain ? { keys: { domain } } : {}),
    source: { class: 'manual' },
  })
  return out.entityId
}

async function graphCounts() {
  const count = async (table: string) =>
    (
      await db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table)}`,
      )
    ).rows[0].n
  return { entity: await count('entity'), alias: await count('entity_alias') }
}

/** An optional company reference on deals, beside the required `company`. */
async function leadInvestor(): Promise<string> {
  const held = (
    await db
      .select({ id: attribute.id })
      .from(attribute)
      .where(
        and(
          eq(attribute.objectId, await objectId('deals')),
          eq(attribute.slug, 'lead_investor'),
        ),
      )
  ).at(0)
  if (held) return held.id
  const created = await Effect.runPromise(
    createAttributeProgram({
      objectKind: 'deal',
      name: 'Lead investor',
      type: 'record_reference',
      config: { targetKind: 'company' },
      createdBy: await actorId(),
    }),
  )
  return created.id
}

describe('a Deals import finds its companies', () => {
  it('plans a reference to the company a name or a domain names, and the preview shows it', async () => {
    const ohmium = await company('Ohmium', 'ohmium.com')
    const batchId = await dealBatch(
      ['Deal', 'Company'],
      [
        ['Ohmium seed', '  ohmium '],
        ['Ohmium A', 'https://www.ohmium.com'],
      ],
    )
    const deals = await objectId('deals')
    const companyAttr = await attributeId(deals, 'company')
    const before = await graphCounts()
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(await graphCounts()).toEqual(before)
    expect(counts).toMatchObject({ create: 2, noLand: 0, cellsSkipped: 0 })

    const byName = await plan(batchId, 1)
    expect(byName.patch).toEqual({ [companyAttr]: ohmium })
    expect(byName.references).toEqual([
      {
        to: 'record',
        column: 1,
        attributeId: companyAttr,
        entityId: ohmium,
        name: 'Ohmium',
      },
    ])
    expect((await plan(batchId, 2)).patch).toEqual({ [companyAttr]: ohmium })

    const view = await Effect.runPromise(
      loadImportPreviewProgram({ batchId, filter: 'all' }),
    )
    expect(view?.rows.map((r) => referenceLands(r.plan))).toEqual([
      '→ Ohmium',
      '→ Ohmium',
    ])
  })

  it('matches exactly: a near name is not a match, whatever the fuzzy sweep would say', async () => {
    await company('Nimbus')
    const lead = await leadInvestor()
    const batchId = await dealBatch(
      ['Deal', 'Company', 'Lead investor'],
      [['Seed', '', 'Nimbus Inc']],
    )
    await map(batchId, 2, { target: 'attribute', attributeId: lead })
    await Effect.runPromise(planImportProgram(batchId))
    const row = await plan(batchId, 1)
    expect(row.verdict).toBe('create')
    expect(row.patch).toEqual({})
    expect(row.skippedCells).toEqual([
      { column: 2, raw: 'Nimbus Inc', reason: 'no such company' },
    ])
  })
})

describe('a name two records answer to', () => {
  /**
   * Two companies born `Acme` and renamed since: a rename keeps the old
   * name alias as history, so both still answer to `Acme`.
   */
  async function twoAcmes() {
    const inc = await company('Acme', 'acme-inc.com')
    const labs = await company('ACME', 'acme-labs.com')
    await db
      .update(entity)
      .set({ canonicalName: 'Acme Inc' })
      .where(eq(entity.id, inc))
    await db
      .update(entity)
      .set({ canonicalName: 'Acme Labs' })
      .where(eq(entity.id, labs))
  }

  it('is a skipped cell naming both on an optional reference — never a coin flip', async () => {
    await twoAcmes()
    const lead = await leadInvestor()
    const batchId = await dealBatch(
      ['Deal', 'Company', 'Lead investor'],
      [['Seed', '', 'acme']],
    )
    await map(batchId, 2, { target: 'attribute', attributeId: lead })
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(counts).toMatchObject({ create: 1, cellsSkipped: 1 })
    const row = await plan(batchId, 1)
    expect(row.patch).toEqual({})
    expect(whyOf(row, ['Deal', 'Company', 'Lead investor'])).toBe(
      'Lead investor "acme" skipped · 2 matches: Acme Inc, Acme Labs · deal birth',
    )
  })

  it("stops the row, naming both, on the deal's required company column", async () => {
    await twoAcmes()
    const batchId = await dealBatch(['Deal', 'Company'], [['Seed', 'Acme']])
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(counts).toMatchObject({ create: 0, noLand: 1 })
    const row = await plan(batchId, 1)
    expect(row.verdict).toBe('no-land')
    expect(whyOf(row, ['Deal', 'Company'])).toBe(
      'B · Company: "Acme" · 2 matches: Acme Inc, Acme Labs',
    )
  })
})

describe('create missing', () => {
  it('off, an unknown company is a skipped cell; on, one create per missing name joins the counts', async () => {
    await company('Helio')
    const lead = await leadInvestor()
    const batchId = await dealBatch(
      ['Deal', 'Company', 'Lead investor'],
      [
        ['A', 'Helio', 'NewCo'],
        ['B', 'Helio', 'newco'],
        ['C', 'Helio', 'Other Co'],
        ['D', 'Helio', 'Helio'],
      ],
    )
    await map(batchId, 2, { target: 'attribute', attributeId: lead })
    const off = await Effect.runPromise(planImportProgram(batchId))
    expect(off.counts).toMatchObject({
      create: 4,
      referenceCreates: 0,
      cellsSkipped: 3,
    })
    expect((await plan(batchId, 1)).skippedCells).toEqual([
      { column: 2, raw: 'NewCo', reason: 'no such company' },
    ])

    await map(batchId, 2, {
      target: 'attribute',
      attributeId: lead,
      createMissing: true,
    })
    const before = await graphCounts()
    const on = await Effect.runPromise(planImportProgram(batchId))
    expect(await graphCounts()).toEqual(before)
    expect(on.counts).toMatchObject({
      create: 6,
      referenceCreates: 2,
      cellsSkipped: 0,
    })
    const first = await plan(batchId, 1)
    expect(first.alsoCreates?.map((c) => c.plan.name)).toEqual(['NewCo'])
    expect((await plan(batchId, 2)).alsoCreates).toBeUndefined()
    expect(first.references?.at(1)).toMatchObject({
      to: 'create',
      name: 'NewCo',
    })

    // The ledger draws each create under the row that carries it.
    const view = await Effect.runPromise(
      loadImportPreviewProgram({ batchId, filter: 'create' }),
    )
    expect(
      view?.rows.flatMap((r) =>
        (r.plan.alsoCreates ?? []).map((c) => [r.rowNum, c.plan.name]),
      ),
    ).toEqual([
      [1, 'NewCo'],
      [3, 'Other Co'],
    ])
  })

  it('on the required company column, a missing company plans its create and the deal lands', async () => {
    const batchId = await dealBatch(
      ['Deal', 'Company'],
      [
        ['A', 'Fresh Co'],
        ['B', 'Fresh  co'],
      ],
    )
    const deals = await objectId('deals')
    const companyAttr = await attributeId(deals, 'company')
    const off = await Effect.runPromise(planImportProgram(batchId))
    expect(off.counts).toMatchObject({ create: 0, noLand: 2 })
    await map(batchId, 1, {
      target: 'attribute',
      attributeId: companyAttr,
      createMissing: true,
    })
    const on = await Effect.runPromise(planImportProgram(batchId))
    expect(on.counts).toMatchObject({ create: 3, noLand: 0 })
  })

  it('a decision that skips the carrier takes its create with it', async () => {
    const createdBy = await actorId()
    const employer = await Effect.runPromise(
      createAttributeProgram({
        objectKind: 'person',
        name: 'Employer',
        type: 'record_reference',
        config: { targetKind: 'company' },
        createdBy,
      }),
    )
    const batchId = await batch(
      ['Name', 'Email', 'Employer'],
      [
        ['Jane Doe', 'jane@shared.io', 'NewCo'],
        ['Janet Roe', 'jane@shared.io', 'NewCo'],
      ],
      await objectId('people'),
    )
    await map(batchId, 2, {
      target: 'attribute',
      attributeId: employer.id,
      createMissing: true,
    })
    const { counts } = await Effect.runPromise(planImportProgram(batchId))
    expect(counts).toMatchObject({ collide: 2, referenceCreates: 0 })
    expect((await plan(batchId, 1)).alsoCreates).toHaveLength(1)

    const kept = await Effect.runPromise(
      decideImportCollisionProgram({
        batchId,
        rowNum: 1,
        decision: 'keep-second',
      }),
    )
    expect(kept.counts).toMatchObject({ create: 2, referenceCreates: 1 })

    await Effect.runPromise(
      mapImportColumnProgram({
        batchId,
        column: 2,
        target: {
          target: 'attribute',
          attributeId: employer.id,
          createMissing: true,
        },
      }),
    )
    await Effect.runPromise(planImportProgram(batchId))
    const skipped = await Effect.runPromise(
      decideImportCollisionProgram({
        batchId,
        rowNum: 1,
        decision: 'skip-both',
      }),
    )
    expect(skipped.counts).toMatchObject({ create: 0, referenceCreates: 0 })
    expect((await plan(batchId, 1)).alsoCreates).toBeUndefined()
    expect((await plan(batchId, 2)).alsoCreates).toBeUndefined()
  })
})

describe('an owner is a member, by email', () => {
  it('resolves an address case-insensitively; a bare name or an unknown address is skipped', async () => {
    await db
      .insert(user)
      .values({ id: 'u-priya', name: 'Priya', email: 'priya@fund.example' })
    const deals = await objectId('deals')
    const owner = await attributeId(deals, 'owner')
    const batchId = await dealBatch(
      ['Deal', 'Company', 'Owner'],
      [
        ['A', '', ' Priya@Fund.Example '],
        ['B', '', 'Priya'],
        ['C', '', 'ghost@fund.example'],
      ],
    )
    await Effect.runPromise(planImportProgram(batchId))
    const a = await plan(batchId, 1)
    expect(a.patch).toEqual({ [owner]: 'u-priya' })
    expect(referenceLands(a)).toBe('→ Priya')
    const header = ['Deal', 'Company', 'Owner']
    expect(whyOf(await plan(batchId, 2), header)).toBe(
      `Owner "Priya" skipped · use the member's email · deal birth`,
    )
    const c = await plan(batchId, 3)
    // Never a fallback to the importing user.
    expect(c.patch).toEqual({})
    expect(whyOf(c, header)).toBe(
      'Owner "ghost@fund.example" skipped · no such member · deal birth',
    )
  })
})

describe('the mapping offers references and counts what it found', () => {
  it('shows record → Companies and member, and n of m found before the preview', async () => {
    await company('Quanta')
    const batchId = await dealBatch(
      ['Deal', 'Company', 'Owner'],
      [
        ['A', 'Quanta', ''],
        ['B', 'Nope', ''],
        ['C', '', ''],
      ],
    )
    const deals = await objectId('deals')
    const companyAttr = await attributeId(deals, 'company')
    const owner = await attributeId(deals, 'owner')
    const loaded = await Effect.runPromise(loadImportMappingProgram(batchId))
    if (!loaded) throw new Error('not on the mapping step')
    expect(loaded.mapping[1]).toEqual({
      target: 'attribute',
      attributeId: companyAttr,
    })
    expect(loaded.attributes.map((a) => a.slug)).toContain('company')
    expect(loaded.references[companyAttr]).toEqual({
      type: 'record → Companies',
      plural: 'Companies',
    })
    expect(loaded.references[owner]).toEqual({ type: 'member', plural: null })
    expect(loaded.columns[1]).toMatchObject({
      parsed: 1,
      total: 2,
      unit: 'found',
      status: 'warn',
      failureCount: 1,
      failures: [
        { rowNum: 2, raw: 'Nope', reason: '"Nope" · no such company' },
      ],
    })
    // A miss is never a reason the step refuses.
    expect(loaded.problems).toEqual([])

    await map(batchId, 1, {
      target: 'attribute',
      attributeId: companyAttr,
      createMissing: true,
    })
    const again = await Effect.runPromise(loadImportMappingProgram(batchId))
    expect(again?.columns[1]).toMatchObject({
      parsed: 1,
      failureCount: 0,
      status: 'ok',
    })
  })
})
