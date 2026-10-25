import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import type { Condition } from '@spaces/core/views/filter'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { logInteractionProgram } from '#/lib/interactions/log'
import { compileViewWhere, viewLensProgram } from './counts'
import { listCompaniesPageProgram, listPeoplePageProgram } from './directory'
import { orderByPage, planSort, sortKeyColumn } from './paging'
import { entityValuesResolver } from './resolve'
import { compileConditions } from './sql'

/**
 * The interaction stat columns as the lists read them: People sorts
 * by Last contact with the quiet ones at the bottom, a logged call moves a
 * row, the `stat:` conditions filter, and the plan reads `interaction_stat`
 * through its `(entity_id, kind)` key.
 */

const DAY = 86_400_000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY)
const utcDay = (d: Date) => d.toISOString().slice(0, 10)

const aPerson = async (name: string) =>
  (await resolveEntity({ kind: 'person', name, source: { class: 'manual' } }))
    .entityId

const logCall = (
  personId: string,
  at: Date,
  kind: 'call' | 'meeting' = 'call',
) =>
  Effect.runPromise(
    logInteractionProgram(FIXTURE_ACTOR.id, {
      kind,
      subject: 'Catch-up',
      occurredAt: at,
      attendeeIds: [personId],
      writeUp: false,
    }),
  )

const byLastContact = { id: 'stat:last_contact', desc: true }

describe('the interaction stat columns', () => {
  it('sorts People by last contact, quiet ones last, and a logged call moves a row', async () => {
    const tag = randomUUID().slice(0, 6)
    const recent = await aPerson(`Recent ${tag}`)
    const older = await aPerson(`Older ${tag}`)
    const quiet = await aPerson(`Quiet ${tag}`)
    const olderAt = daysAgo(40)
    await logCall(recent, daysAgo(1))
    await logCall(older, olderAt)

    const order = async () =>
      (
        await Effect.runPromise(
          listPeoplePageProgram([], { sort: byLastContact, q: tag }),
        )
      ).rows.map((r) => r.id)
    expect(await order()).toEqual([recent, older, quiet])

    const page = await Effect.runPromise(
      listPeoplePageProgram([], { sort: byLastContact, q: tag }),
    )
    const olderRow = page.rows.find((r) => r.id === older)
    expect(olderRow?.stats.lastContact).toBe(olderAt.toISOString())
    expect(olderRow?.stats.lastEmail).toBeNull()
    expect(page.rows.find((r) => r.id === quiet)?.stats).toEqual({
      lastContact: null,
      lastEmail: null,
      nextMeeting: null,
    })

    // Log a call with the quiet one: it goes to the top.
    await logCall(quiet, new Date())
    expect(await order()).toEqual([quiet, recent, older])

    // Ascending keeps the nulls last too, and the cursor pages through them.
    const first = await Effect.runPromise(
      listPeoplePageProgram([], {
        sort: { ...byLastContact, desc: false },
        q: tag,
        limit: 2,
      }),
    )
    expect(first.rows.map((r) => r.id)).toEqual([older, recent])
    const second = await Effect.runPromise(
      listPeoplePageProgram([], {
        sort: { ...byLastContact, desc: false },
        q: tag,
        limit: 2,
        cursor: first.nextCursor,
      }),
    )
    expect(second.rows.map((r) => r.id)).toEqual([quiet])
  })

  it('filters on the stat columns by UTC day, and on emptiness', async () => {
    const tag = randomUUID().slice(0, 6)
    const met = await aPerson(`Met ${tag}`)
    const stale = await aPerson(`Stale ${tag}`)
    const never = await aPerson(`Never ${tag}`)
    const soon = new Date(Date.now() + 3 * DAY)
    await logCall(met, daysAgo(2))
    await logCall(met, soon, 'meeting')
    const staleAt = daysAgo(90)
    await logCall(stale, staleAt)

    const ids = async (conditions: Array<Condition>) =>
      (
        await Effect.runPromise(listPeoplePageProgram(conditions, { q: tag }))
      ).rows
        .map((r) => r.id)
        .sort()

    expect(
      await ids([
        { slug: 'stat:last_contact', op: 'gt', value: utcDay(daysAgo(30)) },
      ]),
    ).toEqual([met])
    expect(
      await ids([
        { slug: 'stat:last_contact', op: 'is', value: utcDay(staleAt) },
      ]),
    ).toEqual([stale])
    expect(await ids([{ slug: 'stat:last_contact', op: 'empty' }])).toEqual([
      never,
    ])
    expect(await ids([{ slug: 'stat:next_meeting', op: 'not_empty' }])).toEqual(
      [met],
    )
    expect(await ids([{ slug: 'stat:last_email', op: 'not_empty' }])).toEqual(
      [],
    )
    const next = (
      await Effect.runPromise(listPeoplePageProgram([], { q: `Met ${tag}` }))
    ).rows.at(0)?.stats.nextMeeting
    expect(next).toBe(soon.toISOString())
  })

  it("companies sort on it too, and a view's count resolves it rather than refusing", async () => {
    const tag = randomUUID().slice(0, 6)
    const a = await resolveEntity({
      kind: 'company',
      name: `Talked ${tag}`,
      keys: { domain: `talked-${tag}.example` },
      source: { class: 'manual' },
    })
    await resolveEntity({
      kind: 'company',
      name: `Silent ${tag}`,
      keys: { domain: `silent-${tag}.example` },
      source: { class: 'manual' },
    })
    const talkedAt = daysAgo(3)
    await logCall(a.entityId, talkedAt)
    const page = await Effect.runPromise(
      listCompaniesPageProgram([], { sort: byLastContact, q: tag }),
    )
    expect(page.rows.at(0)?.id).toBe(a.entityId)
    expect(page.rows.at(0)?.stats.lastContact).toBe(talkedAt.toISOString())

    const objectId = (
      await db
        .select({ objectId: entity.objectId })
        .from(entity)
        .where(eq(entity.id, a.entityId))
    ).at(0)?.objectId
    if (!objectId) throw new Error('no object')
    const lens = await Effect.runPromise(viewLensProgram(objectId))
    const compiled = compileViewWhere(
      [{ slug: 'stat:last_contact', op: 'not_empty' }],
      lens,
    )
    expect('where' in compiled).toBe(true)
  })

  it('reads interaction_stat through its (entity_id, kind) key', async () => {
    // Enough rows that a seq scan per row would be the unambiguously worse plan.
    await db.execute(sql`
      with born as (
        insert into entity (kind, canonical_name)
        select 'person', 'Plan ' || g from generate_series(1, 4000) g
        returning id
      )
      insert into interaction_stat (entity_id, kind, last_at)
      select id, k, now() - (random() * interval '400 days')
      from born cross join unnest(array['any', 'call', 'email', 'meeting']) k
    `)
    await db.execute(sql.raw('analyze entity'))
    await db.execute(sql.raw('analyze interaction_stat'))

    const resolve = entityValuesResolver([])
    const plan = planSort(byLastContact, resolve)
    const filter = compileConditions(
      [{ slug: 'stat:last_email', op: 'not_empty' }],
      resolve,
    )
    const where = and(
      eq(entity.kind, 'person'),
      isNull(entity.mergedIntoId),
      filter,
    )
    const q = db
      .select({ id: entity.id, sortKey: sortKeyColumn(plan) })
      .from(entity)
      .where(where)
      .orderBy(orderByPage(plan))
      .limit(51)
    const { sql: text, params } = q.toSQL()
    const explained = await db.$client.query<{ 'QUERY PLAN': unknown }>({
      text: `explain (format json) ${text}`,
      values: params,
    })
    const planText = JSON.stringify(
      explained.rows.at(0)?.['QUERY PLAN'] ?? null,
    )
    expect(planText).toContain('interaction_stat_entity_id_kind_pk')
    expect(planText).toMatch(/"Node Type":"Index (Only )?Scan"/)
    expect(planText).toContain('"Relation Name":"interaction_stat"')
  })
})
