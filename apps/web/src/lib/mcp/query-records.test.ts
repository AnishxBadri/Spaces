import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Option } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  company,
  entity,
  entitySpace,
  interaction,
  interactionEntity,
  note,
  objectDef,
  space,
  view,
} from '@spaces/db/schema'
import type { EntityValues } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type { Condition } from '@spaces/core/views/filter'
import { recomputeInteractionStats } from '@spaces/core/writes/interactions/stats'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { countViewsProgram } from '#/lib/views/counts'
import {
  QUERY_RECORDS_MAX,
  compileRecordQueryProgram,
  queryRecordsProgram,
  recordsPageStatement,
} from './tools-read'
import type { QueryRecordsInput } from './tools-read'

/**
 * `query_records` over the views compiler (D70, D71): the space condition
 * with descendants, the interaction-stat columns, `total` against the counts
 * compiler, the clamp, and canRead as the token's user.
 */

const me = { id: FIXTURE_ACTOR.id }
const TEAMMATE = {
  id: 'spa260-teammate',
  name: 'Teammate',
  email: 'spa260-teammate@spaces.test',
}

const run = (input: QueryRecordsInput, reader = me) =>
  Effect.runPromise(queryRecordsProgram(reader, input))

/** The refusal's message, or a throw when the program did not refuse. */
async function refusal(input: QueryRecordsInput): Promise<string> {
  const exit = await Effect.runPromiseExit(queryRecordsProgram(me, input))
  if (Exit.isSuccess(exit)) throw new Error('expected a refusal')
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isNone(failure) || failure.value._tag !== 'McpToolRefused')
    throw new Error(`expected McpToolRefused, got ${Cause.pretty(exit.cause)}`)
  return failure.value.message
}

const tag = randomUUID().slice(0, 6)

async function aCompany(name: string, values: EntityValues = {}) {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: `${name} ${tag}`, values })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no company')
  await db.insert(company).values({ entityId: row.id })
  return row.id
}

let slugs = 0
async function aSpace(name: string, parent?: { id: string; path: string }) {
  slugs += 1
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no space')
  const slug = `q${slugs}`
  const path = parent === undefined ? slug : `${parent.path}.${slug}`
  await db
    .insert(space)
    .values({ entityId: row.id, parentId: parent?.id ?? null, slug, path })
  return { id: row.id, path }
}

const file = (entityId: string, spaceId: string) =>
  db.insert(entitySpace).values({ entityId, spaceId })

async function anEmail(at: Date, entityIds: Array<string>) {
  await db.transaction(async (tx) => {
    const row = (
      await tx
        .insert(interaction)
        .values({ kind: 'email', occurredAt: at })
        .returning({ id: interaction.id })
    ).at(0)
    if (!row) throw new Error('no interaction')
    await tx
      .insert(interactionEntity)
      .values(
        entityIds.map((entityId) => ({ interactionId: row.id, entityId })),
      )
    await recomputeInteractionStats(tx, entityIds)
  })
}

const DAY = 86_400_000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY)

const fx = {
  aerospace: { id: '', path: '' },
  launch: { id: '', path: '' },
  smallLift: { id: '', path: '' },
  elsewhere: { id: '', path: '' },
  atRoot: '',
  inLaunch: '',
  inSmallLift: '',
  inSmallLiftSeries: '',
  outside: '',
}

beforeAll(async () => {
  await db.insert(user).values(TEAMMATE)
  fx.aerospace = await aSpace(`Aerospace ${tag}`)
  fx.launch = await aSpace(`Launch ${tag}`, fx.aerospace)
  fx.smallLift = await aSpace(`Small-lift ${tag}`, fx.launch)
  fx.elsewhere = await aSpace(`Elsewhere ${tag}`)

  fx.atRoot = await aCompany('Root', { funding_stage: 'seed' })
  fx.inLaunch = await aCompany('Launcher', { funding_stage: 'seed' })
  fx.inSmallLift = await aCompany('Small', { funding_stage: 'seed' })
  fx.inSmallLiftSeries = await aCompany('Bigger', {
    funding_stage: 'series_a',
  })
  fx.outside = await aCompany('Outside', { funding_stage: 'seed' })
  await file(fx.atRoot, fx.aerospace.id)
  await file(fx.inLaunch, fx.launch.id)
  await file(fx.inSmallLift, fx.smallLift.id)
  await file(fx.inSmallLiftSeries, fx.smallLift.id)
  await file(fx.outside, fx.elsewhere.id)

  // Three seed companies, two emails: Launcher lately, Root long ago, Small
  // never.
  await anEmail(daysAgo(2), [fx.inLaunch])
  await anEmail(daysAgo(30), [fx.atRoot])
})

const ids = (r: { rows: Array<{ id: string }> }) => r.rows.map((x) => x.id)

describe('query_records — the space condition', () => {
  it('takes records filed in the space and every descendant, or the space alone', async () => {
    const all = await run({
      object: 'companies',
      conditions: { space: { id: fx.aerospace.id, includeDescendants: true } },
    })
    expect(new Set(ids(all))).toEqual(
      new Set([fx.atRoot, fx.inLaunch, fx.inSmallLift, fx.inSmallLiftSeries]),
    )
    expect(all.total).toBe(4)

    const only = await run({
      object: 'companies',
      conditions: { space: { id: fx.aerospace.id, includeDescendants: false } },
    })
    expect(ids(only)).toEqual([fx.atRoot])
    expect(only.total).toBe(1)

    // By exact name, descendants by default, ANDed with an attribute.
    const seeded = await run({
      object: 'Company',
      conditions: {
        space: { id: `aerospace ${tag}` },
        funding_stage: 'seed',
      },
    })
    expect(new Set(ids(seeded))).toEqual(
      new Set([fx.atRoot, fx.inLaunch, fx.inSmallLift]),
    )
    expect(seeded.total).toBe(3)
  })

  it('compiles into the one statement — an ltree containment, no query per space', async () => {
    const q = await Effect.runPromise(
      compileRecordQueryProgram(me, {
        object: 'companies',
        conditions: { space: { id: fx.aerospace.id } },
      }),
    )
    const text = recordsPageStatement(q).toSQL().sql
    expect(text).toContain('<@')
    expect(text).toContain('"entity_space"')
  })

  it('refuses a space it cannot find, naming it', async () => {
    expect(
      await refusal({
        object: 'companies',
        conditions: { space: { id: 'Nowhere at all' } },
      }),
    ).toContain('Nowhere at all')
  })
})

describe('query_records — the interaction-stat columns', () => {
  it('sorts three companies by last_interaction from interaction_stat, the quiet one last', async () => {
    // Root (30 days ago), Launcher (2 days ago), Small (never).
    const asked = await run({
      object: 'companies',
      conditions: { funding_stage: 'seed', space: { id: fx.aerospace.id } },
      sort: { by: 'last_interaction', direction: 'desc' },
    })
    expect(ids(asked)).toEqual([fx.inLaunch, fx.atRoot, fx.inSmallLift])
    expect(asked.rows.at(2)?.sortValue).toBeNull()

    const ascending = await run({
      object: 'companies',
      conditions: { funding_stage: 'seed', space: { id: fx.aerospace.id } },
      sort: { by: 'last_interaction', direction: 'asc' },
    })
    expect(ids(ascending)).toEqual([fx.atRoot, fx.inLaunch, fx.inSmallLift])
  })

  it('filters on a stat column by day', async () => {
    const recent = await run({
      object: 'companies',
      conditions: {
        space: { id: fx.aerospace.id },
        last_email: {
          op: 'gt',
          value: daysAgo(10).toISOString().slice(0, 10),
        },
      },
    })
    expect(ids(recent)).toEqual([fx.inLaunch])
    const firsts = await run({
      object: 'companies',
      conditions: {
        space: { id: fx.aerospace.id },
        first_email: { op: 'not_empty' },
      },
      sort: { by: 'first_email' },
    })
    expect(ids(firsts)).toEqual([fx.atRoot, fx.inLaunch])
  })
})

describe('query_records — refusals at the boundary', () => {
  it('refuses an unknown attribute slug, naming it', async () => {
    expect(
      await refusal({
        object: 'companies',
        conditions: { warp_factor: 9 },
      }),
    ).toContain('"warp_factor"')
    // A space-shaped value on any other key is refused, never dropped.
    expect(
      await refusal({
        object: 'companies',
        conditions: { location: { id: fx.aerospace.id } },
      }),
    ).toContain('"location"')
  })

  it('refuses a sort on an attribute nobody flagged, naming what can sort', async () => {
    const message = await refusal({
      object: 'companies',
      sort: { by: 'funding_stage' },
    })
    expect(message).toContain('"funding_stage"')
    expect(message).toContain('last_interaction')
  })
})

describe('query_records — total and limit', () => {
  it('total equals the counts compiler for the same conditions', async () => {
    const companies = (
      await db
        .select({ id: objectDef.id })
        .from(objectDef)
        .where(eq(objectDef.slug, 'companies'))
    ).at(0)
    if (!companies) throw new Error('no companies object')
    const filter: Array<Condition> = [
      { slug: 'funding_stage', op: 'is', value: 'seed' },
      { slug: 'stat:last_email', op: 'not_empty' },
    ]
    const saved = (
      await db
        .insert(view)
        .values({
          surface: 'object',
          objectId: companies.id,
          name: 'Seed, emailed',
          filter,
          createdBy: FIXTURE_ACTOR.id,
        })
        .returning({ id: view.id })
    ).at(0)
    if (!saved) throw new Error('no view')
    const counted = await Effect.runPromise(
      countViewsProgram(companies.id, [saved.id], FIXTURE_ACTOR.id),
    )
    const answered = await run({
      object: 'companies',
      conditions: {
        funding_stage: 'seed',
        'stat:last_email': { op: 'not_empty' },
      },
      limit: 1,
    })
    expect(counted[saved.id]).toEqual({ count: 2 })
    expect(answered.total).toBe(2)
    expect(answered.rows).toHaveLength(1)
  })

  it(`clamps a limit over ${QUERY_RECORDS_MAX}`, async () => {
    await db.execute(sql`
      with born as (
        insert into entity (kind, canonical_name, values)
        select 'company', 'Bulk ' || g || ${` ${tag}`}, '{"location": "bulk"}'::jsonb
        from generate_series(1, ${QUERY_RECORDS_MAX + 5}) g
        returning id
      )
      insert into company (entity_id) select id from born
    `)
    const r = await run({
      object: 'companies',
      conditions: { location: 'bulk' },
      limit: 1000,
    })
    expect(r.rows).toHaveLength(QUERY_RECORDS_MAX)
    expect(r.total).toBe(QUERY_RECORDS_MAX + 5)
  })
})

describe('query_records — canRead as the token’s user', () => {
  it('leaves a record canRead refuses out of the rows and the total', async () => {
    // canRead refuses only a teammate's private note today; a record that
    // carries one is the only way to make it refuse inside an object list.
    const hidden = await aCompany('Hidden', { location: 'canread' })
    const shown = await aCompany('Shown', { location: 'canread' })
    await db.insert(note).values({
      entityId: hidden,
      authorId: TEAMMATE.id,
      visibility: 'private',
    })
    const mine = await run({
      object: 'companies',
      conditions: { location: 'canread' },
    })
    expect(ids(mine)).toEqual([shown])
    expect(mine.total).toBe(1)

    const theirs = await run(
      { object: 'companies', conditions: { location: 'canread' } },
      { id: TEAMMATE.id },
    )
    expect(new Set(ids(theirs))).toEqual(new Set([hidden, shown]))
    expect(theirs.total).toBe(2)
  })
})
