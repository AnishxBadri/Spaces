import { beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from './index.ts'
import { attribute } from './schema/attributes.ts'
import { objectDef } from './schema/objects.ts'
import { reconcileValueIndexes, valueIndexName } from './value-indexes.ts'

/**
 * The reconciler's contract: the `attr_idx_*` indexes on `entity` are a pure
 * function of the flagged, unarchived attributes.
 * - Under test: idempotence, orphan removal, and a failed mint that leaves the
 *   attribute usable and is retried on the next run.
 * - The planner half (the paged query really uses the index) is web's
 *   `value-index-plan` test.
 */

/** The three types core's `isNumericType` compiles numerically. */
const isNumericType = (type: string) =>
  type === 'number' || type === 'currency' || type === 'rating'

const reconcile = (execute?: (statement: string) => Promise<unknown>) =>
  reconcileValueIndexes(
    execute ? { isNumericType, execute } : { isNumericType },
  )

/** The `attr_idx_*` indexes Postgres actually holds on `entity`, by name. */
async function indexesOnEntity(): Promise<Map<string, string>> {
  const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
    select indexname, indexdef from pg_indexes
    where schemaname = current_schema()
      and tablename = 'entity'
      and indexname like 'attr_idx_%'
  `)
  return new Map(rows.rows.map((r) => [r.indexname, r.indexdef]))
}

/**
 * Resets per test, not per file, and drops the indexes a truncate leaves
 * behind, or the reconciler would diff against the last test's leftovers.
 */
async function emptyRegistry(): Promise<void> {
  for (const name of (await indexesOnEntity()).keys())
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`))
  // `truncate … cascade`, not two `delete`s: `object` is the far end of
  // half the schema's foreign keys, and this file only ever puts one object
  // and its attributes there.
  await db.execute(sql.raw('truncate table attribute, "object" cascade'))
}

async function seedObject(): Promise<string> {
  const row = await db
    .insert(objectDef)
    .values({ slug: 'widgets', singular: 'Widget', plural: 'Widgets' })
    .returning({ id: objectDef.id })
  return row[0].id
}

async function seedAttribute(
  objectId: string,
  over: {
    slug: string
    type: 'text' | 'number' | 'status'
    filterable?: boolean
    sortable?: boolean
  },
): Promise<string> {
  const row = await db
    .insert(attribute)
    .values({
      objectId,
      slug: over.slug,
      name: over.slug,
      type: over.type,
      filterable: over.filterable ?? false,
      sortable: over.sortable ?? false,
    })
    .returning({ id: attribute.id })
  return row[0].id
}

describe('reconcileValueIndexes', () => {
  let objectId = ''
  beforeEach(async () => {
    await emptyRegistry()
    objectId = await seedObject()
  })

  it('mints one index per flagged attribute and nothing for the rest', async () => {
    const flagged = await seedAttribute(objectId, {
      slug: 'stage',
      type: 'status',
      filterable: true,
      sortable: true,
    })
    const sortOnly = await seedAttribute(objectId, {
      slug: 'arr',
      type: 'number',
      sortable: true,
    })
    const off = await seedAttribute(objectId, { slug: 'notes', type: 'text' })

    const outcome = await reconcile()
    expect(outcome.failed).toEqual([])
    expect([...outcome.created].sort()).toEqual(
      [valueIndexName(flagged), valueIndexName(sortOnly)].sort(),
    )

    const live = await indexesOnEntity()
    expect([...live.keys()].sort()).toEqual(
      [valueIndexName(flagged), valueIndexName(sortOnly)].sort(),
    )
    expect(live.has(valueIndexName(off))).toBe(false)

    // Leading column first, then the expression the sort key compiles to —
    // text for a status, numeric for a number. Both halves matter: a
    // partial index on a literal object id could not serve `object_id = $1`,
    // and a number indexed as text is not sorted.
    const def = live.get(valueIndexName(flagged)) ?? ''
    expect(def).toMatch(/\(object_id, spaces_json_text\(/)
    expect(def).toContain("'stage'")
    expect(live.get(valueIndexName(sortOnly)) ?? '').toMatch(
      /spaces_json_number\(/,
    )
  })

  it('is a no-op the second time', async () => {
    await seedAttribute(objectId, {
      slug: 'stage',
      type: 'status',
      filterable: true,
    })
    await reconcile()
    const before = await indexesOnEntity()

    const statements: Array<string> = []
    const second = await reconcile(async (statement) => {
      statements.push(statement)
      return db.execute(sql.raw(statement))
    })

    expect(statements).toEqual([])
    expect(second).toEqual({ created: [], dropped: [], failed: [] })
    expect(await indexesOnEntity()).toEqual(before)
  })

  it('drops the index when the flags come off, and when the attribute is archived', async () => {
    const unflag = await seedAttribute(objectId, {
      slug: 'stage',
      type: 'status',
      filterable: true,
      sortable: true,
    })
    const archive = await seedAttribute(objectId, {
      slug: 'owner',
      type: 'text',
      filterable: true,
    })
    await reconcile()
    expect((await indexesOnEntity()).size).toBe(2)

    await db
      .update(attribute)
      .set({ filterable: false, sortable: false })
      .where(eq(attribute.id, unflag))
    await db
      .update(attribute)
      .set({ archived: true })
      .where(eq(attribute.id, archive))

    const outcome = await reconcile()
    expect([...outcome.dropped].sort()).toEqual(
      [valueIndexName(unflag), valueIndexName(archive)].sort(),
    )
    expect((await indexesOnEntity()).size).toBe(0)
  })

  it('leaves the attribute usable when the mint fails, and mints on the next run', async () => {
    const id = await seedAttribute(objectId, {
      slug: 'stage',
      type: 'status',
      filterable: true,
      sortable: true,
    })

    const killed = await reconcile(async () => {
      throw new Error('cluster went away mid-build')
    })
    expect(killed.created).toEqual([])
    expect(killed.failed.map((f) => f.index)).toEqual([valueIndexName(id)])
    expect((await indexesOnEntity()).size).toBe(0)

    // The attribute is untouched by the failure — still flagged, still
    // readable, still writable. An unindexed attribute is a slow list, not
    // a broken one.
    const row = await db
      .select({ filterable: attribute.filterable, slug: attribute.slug })
      .from(attribute)
      .where(eq(attribute.id, id))
    expect(row.at(0)).toEqual({ filterable: true, slug: 'stage' })

    const retried = await reconcile()
    expect(retried.created).toEqual([valueIndexName(id)])
    expect([...(await indexesOnEntity()).keys()]).toEqual([valueIndexName(id)])
  })

  it('replaces an index whose expression no longer matches the query', async () => {
    const id = await seedAttribute(objectId, {
      slug: 'stage',
      type: 'status',
      filterable: true,
    })
    // The shape an interrupted upgrade, or an older release, could leave
    // behind: right name, wrong expression. `IF NOT EXISTS` would keep it
    // forever and the planner would never match it, so the diff has to see
    // past the name.
    await db.execute(
      sql.raw(
        `CREATE INDEX "${valueIndexName(id)}" ON "entity" ("object_id", ("values" ->> 'stage'))`,
      ),
    )

    const outcome = await reconcile()
    expect(outcome.dropped).toEqual([valueIndexName(id)])
    expect(outcome.created).toEqual([valueIndexName(id)])
    expect((await indexesOnEntity()).get(valueIndexName(id))).toContain(
      'spaces_json_text',
    )
  })
})
