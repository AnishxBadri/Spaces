import { beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from './index.ts'
import { attribute } from './schema/attributes.ts'
import { objectDef } from './schema/objects.ts'
import {
  LINK_INDEX_NAME,
  reconcileValueIndexes,
  valueIndexName,
} from './value-indexes.ts'

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
  await db.execute(sql.raw(`DROP INDEX IF EXISTS "${LINK_INDEX_NAME}"`))
  // `truncate … cascade`, not two `delete`s: `object` is the far end of
  // half the schema's foreign keys, and this file only ever puts one object
  // and its attributes there.
  await db.execute(sql.raw('truncate table attribute, "object" cascade'))
}

async function seedObject(slug = 'widgets'): Promise<string> {
  const row = await db
    .insert(objectDef)
    .values({ slug, singular: slug, plural: slug })
    .returning({ id: objectDef.id })
  return row[0].id
}

/** The `attr_idx_*` indexes on `link`, with their definitions. */
async function indexesOnLink(): Promise<Map<string, string>> {
  const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
    select indexname, indexdef from pg_indexes
    where schemaname = current_schema()
      and tablename = 'link'
      and indexname like 'attr_idx_%'
  `)
  return new Map(rows.rows.map((r) => [r.indexname, r.indexdef]))
}

/** A relationship pair: the owner on `ownerObject`, the derived half on `objectId`. */
async function seedPair(
  objectId: string,
  ownerObject: string,
  slug: string,
): Promise<{ owner: string; inverse: string }> {
  const owner = await db
    .insert(attribute)
    .values({
      objectId: ownerObject,
      slug: `${slug}_owner`,
      name: `${slug} owner`,
      type: 'record_reference',
      options: { targetObjectId: objectId, multi: true },
    })
    .returning({ id: attribute.id })
  const inverse = await db
    .insert(attribute)
    .values({
      objectId,
      slug,
      name: slug,
      type: 'record_reference',
      options: {
        targetObjectId: ownerObject,
        multi: true,
        inverseOf: owner[0].id,
        derived: true,
      },
    })
    .returning({ id: attribute.id })
  await db
    .update(attribute)
    .set({
      options: {
        targetObjectId: objectId,
        multi: true,
        inverseOf: inverse[0].id,
      },
    })
    .where(eq(attribute.id, owner[0].id))
  return { owner: owner[0].id, inverse: inverse[0].id }
}

const flag = (id: string, on: boolean) =>
  db
    .update(attribute)
    .set({ filterable: on, sortable: on })
    .where(eq(attribute.id, id))

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

  it('mints the link index once for the first flagged inverse and drops it with the last', async () => {
    const people = await seedObject('gadgets')
    const team = await seedPair(objectId, people, 'team')
    const crew = await seedPair(objectId, people, 'crew')

    await flag(team.inverse, true)
    const first = await reconcile()
    expect(first.failed).toEqual([])
    // The link index, and no `values` index for a half that stores nothing.
    expect(first.created).toEqual([LINK_INDEX_NAME])
    expect((await indexesOnEntity()).size).toBe(0)
    expect(await indexesOnLink()).toEqual(
      new Map([
        [
          LINK_INDEX_NAME,
          expect.stringMatching(/USING btree \(to_entity_id, attr_slug\)$/),
        ],
      ]),
    )

    // A second inverse shares it: nothing is minted twice.
    await flag(crew.inverse, true)
    const second = await reconcile()
    expect(second).toEqual({ created: [], dropped: [], failed: [] })
    expect((await indexesOnLink()).size).toBe(1)

    // It stays while any inverse is flagged, and goes with the last.
    await flag(team.inverse, false)
    expect(await reconcile()).toEqual({ created: [], dropped: [], failed: [] })
    await flag(crew.inverse, false)
    const last = await reconcile()
    expect(last.dropped).toEqual([LINK_INDEX_NAME])
    expect((await indexesOnLink()).size).toBe(0)
  })

  it('replaces a link index whose columns no longer match', async () => {
    const people = await seedObject('gadgets')
    const team = await seedPair(objectId, people, 'team')
    await flag(team.inverse, true)
    await db.execute(
      sql.raw(`CREATE INDEX "${LINK_INDEX_NAME}" ON "link" ("to_entity_id")`),
    )
    const outcome = await reconcile()
    expect(outcome.dropped).toEqual([LINK_INDEX_NAME])
    expect(outcome.created).toEqual([LINK_INDEX_NAME])
    expect((await indexesOnLink()).get(LINK_INDEX_NAME)).toContain(
      'to_entity_id, attr_slug',
    )
  })
})
