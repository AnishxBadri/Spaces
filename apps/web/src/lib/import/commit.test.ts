import { Effect } from 'effect'
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  activity,
  attribute,
  attributeEvent,
  duplicateCandidate,
  entity,
  entityAlias,
  importBatch,
  importRow,
  objectDef,
} from '@spaces/db/schema'
import { holding } from '@spaces/db/schema/portfolio'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueued } from '#/test/queue-stub'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  createObjectProgram,
  createRecordProgram,
} from '#/lib/attributes/object-registry'
import { resolveEntity } from '#/lib/entities/resolve'
import { birthDealProgram, dealFromDialog } from '#/lib/deals/birth'
import { beginImportMappingProgram } from './mapping'
import { decideImportCollisionProgram, planImportProgram } from './plan'
import {
  commitImportProgram,
  commitMessage,
  loadImportReceiptProgram,
  requestCommitProgram,
} from './commit'
import type { RowPlan } from '@spaces/core/import/plan'

/**
 * Idempotent commit (SPA-169). Batches are inserted straight into the tables
 * and planned through the real preview, as `plan.test.ts` does; the commit
 * program is driven directly, and once through `runJob` for its `job_run`
 * row. Counts are read from every table a commit can touch, so "a re-run
 * writes nothing" is asserted end to end rather than inferred.
 */

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const ME = FIXTURE_ACTOR.id

beforeEach(() => {
  enqueued.length = 0
})

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

/** A staged batch, mapped by the auto-guess and planned by the real preview. */
async function plannedBatch(
  header: Array<string>,
  rows: Array<Array<string>>,
  targetObjectId: string,
): Promise<string> {
  const inserted = (
    await db
      .insert(importBatch)
      .values({
        blobSha: 'c'.repeat(64),
        filename: 'sheet.csv',
        sizeBytes: 100,
        sheet: 'sheet',
        sheets: ['sheet'],
        headerRow: 0,
        header,
        mode: 'records',
        targetObjectId,
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
  await Effect.runPromise(beginImportMappingProgram(inserted.id))
  await Effect.runPromise(planImportProgram(inserted.id))
  return inserted.id
}

const commit = (batchId: string, onlyFailed = false) =>
  Effect.runPromise(commitImportProgram({ batchId, userId: ME, onlyFailed }))

/** Every table a commit can write, counted. */
async function tableCounts() {
  const tables = [
    'entity',
    'entity_alias',
    'attribute_event',
    'company',
    'person',
    'link',
    'activity',
    'holding',
    'duplicate_candidate',
  ]
  const out: Record<string, number> = {}
  for (const t of tables)
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

async function planOf(batchId: string, rowNum: number): Promise<RowPlan> {
  const row = (await rowsOf(batchId)).find((r) => r.rowNum === rowNum)
  if (!row?.plan) throw new Error(`row ${rowNum} has no plan`)
  return row.plan
}

async function attributeId(objectSlug: string, slug: string) {
  const row = (
    await db
      .select({ id: attribute.id })
      .from(attribute)
      .innerJoin(objectDef, eq(objectDef.id, attribute.objectId))
      .where(and(eq(objectDef.slug, objectSlug), eq(attribute.slug, slug)))
  ).at(0)
  if (!row) throw new Error(`attribute ${objectSlug}.${slug} missing`)
  return row.id
}

describe('the first import lands, and a re-run writes nothing', () => {
  it('commits a 200-row sheet, then commits it again with every count unchanged', async () => {
    const companies = await objectId('companies')
    const rows: Array<Array<string>> = []
    for (let i = 0; i < 200; i++)
      rows.push([`Acme Holding ${i}`, `acme-${i}.com`, String(2000 + (i % 20))])
    const batchId = await plannedBatch(
      ['Name', 'Domain', 'Founded'],
      rows,
      companies,
    )
    const before = await tableCounts()

    const first = await commit(batchId)
    expect(first).toEqual({
      written: 200,
      attached: 0,
      failed: 0,
      unchanged: 0,
    })
    const after = await tableCounts()
    expect(after.entity - before.entity).toBe(200)
    expect(after.company - before.company).toBe(200)

    const batch = (
      await db.select().from(importBatch).where(eq(importBatch.id, batchId))
    ).at(0)
    expect(batch?.status).toBe('committed')
    expect(batch?.committedAt).not.toBeNull()
    const landed = await rowsOf(batchId)
    expect(landed.every((r) => r.entityId !== null && r.error === null)).toBe(
      true,
    )

    // Again, on the committed batch: nothing written, and it says so.
    const again = await commit(batchId)
    expect(again).toEqual({
      written: 0,
      attached: 0,
      failed: 0,
      unchanged: 200,
    })
    expect(await tableCounts()).toEqual(after)

    // And a run that finds the rows holding their records — a job that died
    // before it could mark the batch — writes nothing either.
    await db
      .update(importBatch)
      .set({ status: 'planned', committedAt: null })
      .where(eq(importBatch.id, batchId))
    const resumed = await commit(batchId)
    expect(resumed).toEqual({
      written: 0,
      attached: 0,
      failed: 0,
      unchanged: 200,
    })
    expect(await tableCounts()).toEqual(after)
  }, 240_000)

  it('stamps every value with the importing human and the batch, and no machine actor', async () => {
    const companies = await objectId('companies')
    const batchId = await plannedBatch(
      ['Name', 'Domain', 'Founded'],
      [
        ['Receipt One', 'receipt-one.com', '2015'],
        ['Receipt Two', 'receipt-two.com', '2016'],
      ],
      companies,
    )
    await commit(batchId)
    const ids = (await rowsOf(batchId)).flatMap((r) =>
      r.entityId ? [r.entityId] : [],
    )
    expect(ids).toHaveLength(2)

    const events = await db
      .select()
      .from(attributeEvent)
      .where(inArray(attributeEvent.entityId, ids))
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect(e.actorType).toBe('user')
      expect(e.actorId).toBe(ME)
      expect(e.batchId).toBe(batchId)
    }
    expect(
      events.filter(
        (e) => e.attrSlug === 'founded_year' && e.source === 'import',
      ),
    ).toHaveLength(2)
    // Findable by batch alone.
    const byBatch = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(attributeEvent)
      .where(eq(attributeEvent.batchId, batchId))
    expect(byBatch.at(0)?.n).toBe(events.length)

    const born = await db
      .select({ sourceClass: entity.sourceClass, createdBy: entity.createdBy })
      .from(entity)
      .where(inArray(entity.id, ids))
    for (const b of born) {
      expect(b.sourceClass).toBe('import')
      expect(b.createdBy).toBe(ME)
    }
    const machine = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.batchId, batchId),
          ne(attributeEvent.actorType, 'user'),
        ),
      )
    expect(machine.at(0)?.n).toBe(0)
  })
})

describe('a row that fails', () => {
  it('leaves every other row committed, records its reason, and re-runs alone', async () => {
    const companies = await objectId('companies')
    const batchId = await plannedBatch(
      ['Name', 'Domain', 'Founded'],
      [
        ['Steady One', 'steady-one.com', '2010'],
        ['Broken Row', 'broken-row.com', '2011'],
        ['Steady Three', 'steady-three.com', '2012'],
      ],
      companies,
    )
    // A value the write path refuses, as a sheet the registry moved under
    // would produce: the plan says a number, the cell says otherwise.
    const founded = await attributeId('companies', 'founded_year')
    const broken = await planOf(batchId, 2)
    await db
      .update(importRow)
      .set({
        plan: { ...broken, patch: { ...broken.patch, [founded]: 'soon' } },
      })
      .where(and(eq(importRow.batchId, batchId), eq(importRow.rowNum, 2)))

    // Counted by name, not by table: the file's other tests share the table.
    const steady = () =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(entity)
        .where(
          inArray(entity.canonicalName, [
            'Steady One',
            'Broken Row',
            'Steady Three',
          ]),
        )
        .then((r) => r.at(0)?.n ?? 0)
    const run = await commit(batchId)
    expect(run).toEqual({ written: 2, attached: 0, failed: 1, unchanged: 0 })
    const rows = await rowsOf(batchId)
    expect(rows[0].entityId).not.toBeNull()
    expect(rows[2].entityId).not.toBeNull()
    expect(rows[1].entityId).toBeNull()
    expect(rows[1].error).toMatch(/^founded_year: /)
    // The failed row rolled back whole: no record, no alias, no event.
    expect(await steady()).toBe(2)
    const orphan = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(entity)
      .where(eq(entity.canonicalName, 'Broken Row'))
    expect(orphan.at(0)?.n).toBe(0)

    const receipt = await Effect.runPromise(
      loadImportReceiptProgram({ batchId, filter: 'failed' }),
    )
    expect(receipt?.counts).toEqual({
      written: 2,
      attached: 0,
      failed: 1,
      remaining: 0,
    })
    expect(receipt?.rows.map((r) => r.rowNum)).toEqual([2])
    expect(receipt?.rows[0].outcome.kind).toBe('failed')

    // The sheet is fixed; the failed row alone runs again.
    await db
      .update(importRow)
      .set({ plan: broken })
      .where(and(eq(importRow.batchId, batchId), eq(importRow.rowNum, 2)))
    const retry = await commit(batchId, true)
    expect(retry).toEqual({ written: 1, attached: 0, failed: 0, unchanged: 2 })
    const fixed = await rowsOf(batchId)
    expect(fixed[1].entityId).not.toBeNull()
    expect(fixed[1].error).toBeNull()
    expect(await steady()).toBe(3)

    await expect(
      Effect.runPromise(
        requestCommitProgram({ batchId, userId: ME, onlyFailed: true }),
      ),
    ).rejects.toSatisfy((e) => commitMessage(e) === 'No failed rows to retry')
  })
})

describe('re-resolve on commit', () => {
  it('attaches a row whose record was born between the preview and the commit', async () => {
    const companies = await objectId('companies')
    const batchId = await plannedBatch(
      ['Name', 'Domain'],
      [['Latecomer', 'latecomer.io']],
      companies,
    )
    expect((await planOf(batchId, 1)).verdict).toBe('create')
    const meanwhile = await resolveEntity({
      kind: 'company',
      name: 'Latecomer Inc',
      keys: { domain: 'latecomer.io' },
      source: { class: 'manual' },
    })
    const run = await commit(batchId)
    expect(run.attached).toBe(1)
    const row = (await rowsOf(batchId))[0]
    expect(row.entityId).toBe(meanwhile.entityId)
    expect(row.plan?.verdict).toBe('create')
    expect(row.plan?.committedAs).toBe('attach')
  })
})

describe('a domain identity alias', () => {
  it('stores the host the record matches on, not the cell as the sheet spelled it', async () => {
    const companies = await objectId('companies')
    const batchId = await plannedBatch(
      ['Name', 'Website'],
      [['Example', 'https://www.Example.com/']],
      companies,
    )
    const run = await commit(batchId)
    expect(run.written).toBe(1)
    const row = (await rowsOf(batchId))[0]
    if (row.entityId === null) throw new Error('row 1 wrote no record')
    const aliases = await db
      .select({ value: entityAlias.value, valueNorm: entityAlias.valueNorm })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.entityId, row.entityId),
          eq(entityAlias.kind, 'domain'),
        ),
      )
    expect(aliases).toEqual([
      { value: 'example.com', valueNorm: 'example.com' },
    ])
  })
})

describe('collisions and merges', () => {
  it('refuses an undecided collision, folds a merge, and records a skip', async () => {
    const companies = await objectId('companies')
    const batchId = await plannedBatch(
      ['Name', 'Domain', 'Founded', 'Location'],
      [
        ['Twin Co', 'twin.co', '2001', ''],
        ['Twin Co', 'twin.co', '1999', 'Pune'],
        ['Fork A', 'fork.co', '', ''],
        ['Fork B', 'fork.co', '', ''],
      ],
      companies,
    )
    expect((await planOf(batchId, 2)).verdict).toBe('merged')
    expect((await planOf(batchId, 3)).verdict).toBe('collide')
    await expect(
      Effect.runPromise(
        requestCommitProgram({ batchId, userId: ME, onlyFailed: false }),
      ),
    ).rejects.toSatisfy((e) => commitMessage(e).startsWith('2 rows collide'))
    expect(enqueued).toHaveLength(0)

    await Effect.runPromise(
      decideImportCollisionProgram({
        batchId,
        rowNum: 3,
        decision: 'skip-both',
      }),
    )
    const queued = await Effect.runPromise(
      requestCommitProgram({ batchId, userId: ME, onlyFailed: false }),
    )
    expect(queued).toEqual({ queued: true })
    expect(enqueued[0]).toMatchObject({
      name: QUEUES.importCommit,
      data: { batchId, userId: ME, onlyFailed: false },
      options: { singletonKey: batchId },
    })
    // A double click: pg-boss (here, its stand-in) refuses the second.
    const twice = await Effect.runPromise(
      requestCommitProgram({ batchId, userId: ME, onlyFailed: false }),
    )
    expect(twice).toEqual({ queued: false })

    const run = await commit(batchId)
    expect(run.written).toBe(1)
    const rows = await rowsOf(batchId)
    // The merged row wrote nothing itself and lands on row 1's record.
    expect(rows[1].entityId).toBe(rows[0].entityId)
    const twin = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, rows[0].entityId ?? ''))
    ).at(0)
    // Blanks only, first wins: row 1's founded year stands, row 2 fills location.
    expect(twin?.values.founded_year).toBe(2001)
    expect(twin?.values.location).toBe('Pune')
    expect(rows[2].entityId).toBeNull()
    expect(rows[2].plan?.skipReason).toBe('both rows skipped by decision')
    expect(rows[3].plan?.skipReason).toBe('both rows skipped by decision')
    const forks = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(entity)
      .where(
        or(
          eq(entity.canonicalName, 'Fork A'),
          eq(entity.canonicalName, 'Fork B'),
        ),
      )
    expect(forks.at(0)?.n).toBe(0)
  })
})

describe('custom objects feed the review inbox through their own sweep', () => {
  it('pairs near-identical names within the object, and never across objects', async () => {
    const funds = await Effect.runPromise(
      createObjectProgram({
        singular: 'Fund',
        plural: 'Funds',
        identityKeys: [],
        createdBy: ME,
      }),
    )
    const vendors = await Effect.runPromise(
      createObjectProgram({
        singular: 'Vendor',
        plural: 'Vendors',
        identityKeys: [],
        createdBy: ME,
      }),
    )
    // Same name, another object: the object-scoped sweep must not see it.
    const vendor = await Effect.runPromise(
      createRecordProgram({
        objectId: vendors.id,
        name: 'Sequoia Capital',
        actor: { type: 'user', id: ME },
        source: 'manual',
      }),
    )
    const batchId = await plannedBatch(
      ['Name'],
      [['Sequoia Capital'], ['Sequoia Capitol'], ['Lightspeed']],
      funds.id,
    )
    const run = await commit(batchId)
    expect(run.written).toBe(3)
    const ids = (await rowsOf(batchId)).flatMap((r) =>
      r.entityId ? [r.entityId] : [],
    )
    const born = await db
      .select({ sourceClass: entity.sourceClass, objectId: entity.objectId })
      .from(entity)
      .where(inArray(entity.id, ids))
    expect(born.every((b) => b.sourceClass === 'import')).toBe(true)
    expect(born.every((b) => b.objectId === funds.id)).toBe(true)

    const pairs = await db
      .select({ a: duplicateCandidate.entityA, b: duplicateCandidate.entityB })
      .from(duplicateCandidate)
    const within = pairs.filter((p) => ids.includes(p.a) && ids.includes(p.b))
    expect(within).toHaveLength(1)
    expect(
      pairs.filter((p) => p.a === vendor.id || p.b === vendor.id),
    ).toHaveLength(0)
  })
})

describe('a Deals row at Invested', () => {
  it('births its holding through the program createDeal calls, with identical rows', async () => {
    const byDialog = await resolveEntity({
      kind: 'company',
      name: 'Dialog Target',
      keys: { domain: 'dialog-target.com' },
      source: { class: 'manual' },
    })
    const byImport = await resolveEntity({
      kind: 'company',
      name: 'Import Target',
      keys: { domain: 'import-target.com' },
      source: { class: 'manual' },
    })

    // `createDeal`'s handler below `requireUser`, exactly.
    const dialog = await Effect.runPromise(
      birthDealProgram(
        dealFromDialog(
          {
            companyId: byDialog.entityId,
            name: 'Seed round',
            stage: 'invested',
            value: 250000,
          },
          ME,
        ),
      ),
    )

    const deals = await objectId('deals')
    const batchId = await plannedBatch(
      ['Name', 'Company', 'Stage', 'Value'],
      [['Seed round', 'Import Target', 'invested', '250000']],
      deals,
    )
    const run = await commit(batchId)
    expect(run).toEqual({ written: 1, attached: 0, failed: 0, unchanged: 0 })
    const imported = (await rowsOf(batchId))[0].entityId
    if (imported === null) throw new Error('the deal did not land')

    const shape = async (dealId: string, companyId: string) => {
      const e = (
        await db.select().from(entity).where(eq(entity.id, dealId))
      ).at(0)
      if (!e) throw new Error('deal missing')
      const { company, ...values } = e.values
      const held = await db
        .select({ id: holding.id })
        .from(holding)
        .where(eq(holding.companyId, companyId))
      const verbs = await db
        .select({ verb: activity.verb })
        .from(activity)
        .where(
          or(
            eq(activity.objectEntityId, dealId),
            and(
              eq(activity.subjectEntityId, companyId),
              eq(activity.verb, 'holding.created'),
            ),
          ),
        )
      const events = await db
        .select({
          slug: attributeEvent.attrSlug,
          source: attributeEvent.source,
          actorId: attributeEvent.actorId,
        })
        .from(attributeEvent)
        .where(eq(attributeEvent.entityId, dealId))
      return {
        kind: e.kind,
        name: e.canonicalName,
        createdBy: e.createdBy,
        company,
        values,
        holdings: held.length,
        verbs: verbs.map((v) => v.verb).sort(),
        eventSlugs: events.map((ev) => ev.slug).sort(),
        actors: [...new Set(events.map((ev) => ev.actorId))],
        sourceClass: e.sourceClass,
        sources: [
          ...new Set(
            events
              .filter((ev) => ev.source !== 'default')
              .map((ev) => ev.source),
          ),
        ],
      }
    }
    const a = await shape(dialog.id, byDialog.entityId)
    const b = await shape(imported, byImport.entityId)
    expect(a.company).toBe(byDialog.entityId)
    expect(b.company).toBe(byImport.entityId)
    expect(b.holdings).toBe(1)
    // Identical births; only the door differs, and says so.
    const { company: _a, sourceClass: sa, sources: xa, ...restA } = a
    const { company: _b, sourceClass: sb, sources: xb, ...restB } = b
    expect(restB).toEqual(restA)
    expect([sa, xa]).toEqual(['manual', ['direct']])
    expect([sb, xb]).toEqual(['import', ['import']])
  })
})
