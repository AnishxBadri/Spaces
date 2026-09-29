import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Condition } from '@spaces/core/views/filter'

/**
 * The half of SPA-93 that cannot be argued, only measured: does the planner
 * actually use `attr_idx_<id>` for the query the list page runs?
 *
 * Everything else about the reconciler is asserted in
 * `packages/db/src/value-indexes.test.ts`. This file asserts the one claim
 * the whole slice rests on — and it has to, because an expression index that
 * does not match the emitted expression is *invisible*: the page is exactly
 * as slow as before, no error is raised anywhere, and `\d entity` shows the
 * index sitting there looking correct. That failure mode is why the recorded
 * decision said "prove that with an EXPLAIN assertion rather than trusting
 * it", and it is what `views-3`'s recorded seq-scan baseline was measured
 * against.
 *
 * **What the index can and cannot do.** It serves the `order by`. It does
 * not serve the `where`: `compileConditions` wraps every condition in
 * `coalesce(…, false)` so SQL's third truth value cannot leak, and a
 * `CoalesceExpr` is not a clause the planner can match to an index key. So
 * the plan under test is the paged query with a condition *and* a sort — an
 * index scan in `attr_idx_…` order, with the condition applied as a filter —
 * which is the shape the sort-a-big-object demo runs.
 *
 * The query is rebuilt here from the same three seams `records.ts` composes
 * (`entityValuesResolver`, `compileConditions`, `compileSortKey`) rather
 * than imported: `listRecordsProgram` runs its query, and EXPLAIN needs the
 * query. Rebuilding from the same seams is what makes the assertion
 * meaningful — if `compileSortKey` ever emits something the reconciler does
 * not index, this goes red.
 */

/** Big enough that a seq scan plus a sort is unambiguously the worse plan. */
const ROWS = 8000

/**
 * Deliberately not `stage`. The indexed expression is
 * `spaces_json_text(values -> '<slug>')` and nothing in it names the
 * attribute's object, so two attributes on different objects that share a
 * slug share an index shape — and the seeded, flagged `deal.stage` would
 * have answered this query after the fixture's own index was dropped,
 * turning the "and now it stops" half of the assertion green for the wrong
 * reason.
 */
const SLUG = 'spa93_rank'

type Fixture = { objectId: string; attributeId: string; indexName: string }

/** One of drizzle's bind values, spelled as a SQL literal for `EXECUTE`. */
function literalArg(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

async function seam() {
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')
  const { and, eq, isNull, sql } = await import('drizzle-orm')
  const { compileConditions, compileSortKey } = await import('./sql')
  const { entityValuesResolver } = await import('./resolve')
  return {
    db,
    entity,
    and,
    eq,
    isNull,
    sql,
    compileConditions,
    compileSortKey,
    entityValuesResolver,
  }
}

/**
 * `records.ts`'s page query, built from `records.ts`'s seams: one object's
 * live records, narrowed by a view condition, ordered by an attribute,
 * capped at a page. `object_id` goes in as a bind parameter, which is the
 * whole reason the index leads with it rather than being partial on a
 * literal id.
 */
/**
 * How the statement is planned. `custom` is the production path — node-
 * postgres sends unnamed statements, which Postgres plans with the bind
 * values in hand. `generic` is the harder case: the statement is prepared
 * and planned with `object_id` known only as `$1`, which is what a named
 * statement, a `PREPARE`, or a statement-pooling proxy would produce, and
 * what a partial index on a literal object id could never serve.
 */
type PlanMode = 'custom' | 'generic'

async function pagePlan(
  objectId: string,
  mode: PlanMode = 'custom',
): Promise<string> {
  const s = await seam()
  const resolve = s.entityValuesResolver([{ slug: SLUG, type: 'status' }])
  const field = resolve(SLUG)
  if (!field) throw new Error('the fixture attribute did not resolve')
  const conditions: Array<Condition> = [{ slug: SLUG, op: 'not_empty' }]
  const filter = s.compileConditions(conditions, resolve)
  const key = s.compileSortKey(field)
  const dir = s.sql`asc`

  const page = s.db
    .select({
      id: s.entity.id,
      name: s.entity.canonicalName,
      values: s.entity.values,
      sortKey: s.sql<string | null>`(${key.expr})::text`,
    })
    .from(s.entity)
    .where(
      s.and(
        s.eq(s.entity.objectId, objectId),
        s.eq(s.entity.kind, 'custom'),
        s.isNull(s.entity.mergedIntoId),
        filter,
      ),
    )
    .orderBy(s.sql`${key.expr} ${dir} nulls last, ${s.entity.id} ${dir}`)
    .limit(51)

  // The plan is asserted as text either way. Walking the node tree would
  // need a cast the compiler could not check, and the questions asked of it
  // — which scan, which index, which condition — are answered by the names
  // in it.
  const { sql: text, params } = page.toSQL()
  if (mode === 'custom') {
    const explained = await s.db.$client.query<{ 'QUERY PLAN': unknown }>({
      text: `explain (format json) ${text}`,
      values: params,
    })
    return JSON.stringify(explained.rows.at(0)?.['QUERY PLAN'] ?? null)
  }

  // One pinned connection, because a prepared statement is session state.
  // `EXECUTE` takes no outer bind parameters, so the arguments are spelled
  // as literals — which changes nothing: the statement was prepared from
  // `$1…$n` and `force_generic_plan` makes Postgres plan it without looking
  // at them at all.
  const name = `spa93_${randomUUID().replaceAll('-', '')}`
  const args = params.map(literalArg).join(', ')
  const client = await s.db.$client.connect()
  try {
    await client.query(`prepare ${name} as ${text}`)
    await client.query('set plan_cache_mode = force_generic_plan')
    const explained = await client.query<{ 'QUERY PLAN': unknown }>(
      `explain (format json) execute ${name}(${args})`,
    )
    return JSON.stringify(explained.rows.at(0)?.['QUERY PLAN'] ?? null)
  } finally {
    client.release()
  }
}

async function fixture(): Promise<Fixture> {
  const { db } = await import('@spaces/db')
  const { attribute, objectDef } = await import('@spaces/db/schema')
  const { sql } = await import('drizzle-orm')
  const { valueIndexName } = await import('@spaces/db/value-indexes')

  // The suite truncates tables between files but never drops an index, and
  // this database outlives the run — so a previous run's `attr_idx_` on the
  // same expression would answer the "before" plan and the test would prove
  // nothing.
  const stale = await db.execute<{ indexname: string }>(sql`
    select indexname from pg_indexes
    where schemaname = current_schema()
      and tablename = 'entity' and indexname like 'attr_idx_%'
  `)
  for (const row of stale.rows)
    await db.execute(sql.raw(`drop index if exists "${row.indexname}"`))

  const tag = randomUUID().slice(0, 8)
  const object = await db
    .insert(objectDef)
    .values({
      slug: `funds-${tag}`,
      singular: `Fund ${tag}`,
      plural: `Funds ${tag}`,
    })
    .returning({ id: objectDef.id })
  const objectId = object[0].id

  const attr = await db
    .insert(attribute)
    .values({
      objectId,
      slug: SLUG,
      name: 'Stage',
      type: 'status',
      options: {
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      filterable: true,
      sortable: true,
    })
    .returning({ id: attribute.id })

  // The rows, straight in: this file is about the plan, and eight thousand
  // trips through the value write path would be a different test.
  await db.execute(sql`
    insert into entity (kind, object_id, canonical_name, values)
    select 'custom', ${objectId}::uuid, 'Row ' || g,
           jsonb_build_object(${SLUG}::text, 'stage_' || (g % 9))
    from generate_series(1, ${ROWS}) g
  `)
  await db.execute(sql.raw('analyze entity'))

  return {
    objectId,
    attributeId: attr[0].id,
    indexName: valueIndexName(attr[0].id),
  }
}

describe('the paged list plan', () => {
  let fx: Fixture
  beforeAll(async () => {
    fx = await fixture()
  })

  it('scans attr_idx_… once the attribute is flagged, and stops when it is not', async () => {
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { reconcileAttributeIndexes } =
      await import('@spaces/core/writes/attributes/reconcile')

    // Before: nothing to use, so the object is read whole and sorted.
    const cold = await pagePlan(fx.objectId)
    expect(cold).toContain('Seq Scan')
    expect(cold).not.toContain('attr_idx_')

    const minted = await reconcileAttributeIndexes()
    expect(minted.failed).toEqual([])
    expect(minted.created).toContain(fx.indexName)

    const warm = await pagePlan(fx.objectId)
    expect(warm).toContain(fx.indexName)
    expect(warm).toMatch(/"Node Type":"(Index|Bitmap Index) Scan"/)
    // And the order came out of the index: `Presorted Key` is Postgres
    // saying it did not have to sort by the attribute at all. What is left
    // is an incremental sort inside each tied key, for the `id` tiebreak —
    // a page deep, not eight thousand rows deep.
    expect(warm).toContain('"Presorted Key"')
    expect(warm).toContain('spaces_json_text')

    // The same plan when the statement is planned without the bind values:
    // `object_id = $1` is an ordinary equality on the index's leading key,
    // which is the whole reason the index is composite and not partial on a
    // literal object id — Postgres cannot prove `$1` equals a literal, so a
    // partial index would be unusable here and this assertion would fail.
    const generic = await pagePlan(fx.objectId, 'generic')
    expect(generic).toContain(fx.indexName)
    expect(generic).toMatch(/"Index Cond":"\(object_id = \$\d+\)"/)
    expect(generic).toContain('"Presorted Key"')

    // Untick it: the index goes, with no restart, and the plan goes back.
    await db
      .update(attribute)
      .set({ filterable: false, sortable: false })
      .where(eq(attribute.id, fx.attributeId))
    const dropped = await reconcileAttributeIndexes()
    expect(dropped.dropped).toContain(fx.indexName)

    const cooled = await pagePlan(fx.objectId)
    expect(cooled).toContain('Seq Scan')
    expect(cooled).not.toContain('attr_idx_')
  })
})
