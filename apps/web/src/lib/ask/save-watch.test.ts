import { Effect, Exit } from 'effect'
import { and, count, eq, sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  askThread,
  askTurn,
  entity,
  integration,
  space,
  spaceWatch,
  spaceWatchDismissal,
  suggestion,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { defineManifest, toManifestJson } from '@spaces/sdk'
import { jsonRecord, jsonValue } from '@spaces/core/json'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { addFindRowProgram, dismissFindRowProgram } from './find'
import { saveFindAsWatchProgram } from './save-watch'
import { getThreadProgram } from './threads'
import type { AskCall, AskFindRow, AskFindTable } from './types'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Save as watch against the test database: one `space_watch`, the turn's
 * untouched rows as `add_record` cards under the space, the added and
 * dismissed rows left as they are, the thread's link and its deleted
 * state, and the same lens refused with nothing written.
 */

const run = <TValue, TError>(e: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(e)

const me = FIXTURE_ACTOR.id

const anEngine = async () => {
  const manifest = jsonRecord(
    jsonValue.parse(
      toManifestJson(
        defineManifest({
          manifestVersion: 1,
          id: 'exa',
          version: '0.1.0',
          sdk: '^1.5',
          name: 'Exa',
          description: 'A test engine.',
          settings: z.object({}),
          jobs: {
            watch: {
              trigger: 'watch',
              uses: ['Spaces'],
              settings: z.object({
                criteria: z.string().max(1000).default(''),
                cap: z.int().min(1).max(100).default(10),
              }),
            },
          },
        }),
      ),
    ),
  )
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'exa',
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        manifest,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  return row.id
}

let n = 0
const aSpace = async (name: string, criteria: string | null = null) => {
  n += 1
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  await db
    .insert(space)
    .values({ entityId: ent.id, slug: `sw${n}`, path: `sw${n}`, criteria })
  return { id: ent.id, name }
}

const QUESTION = 'Find property management operators in Pune'

const row = (name: string, domain: string, via: string): AskFindRow => ({
  name,
  domain,
  line: `${name} runs buildings`,
  place: 'Pune',
  sources: [{ url: `https://${domain}/about` }],
  via: { integrationId: via, name: 'Exa' },
  standing: 'unknown',
  entityId: null,
})

/** A stored Find turn: the question, then the answer holding the table. */
const aFindTurn = async (table: AskFindTable) => {
  const thread = (
    await db
      .insert(askThread)
      .values({ userId: me, title: QUESTION })
      .returning({ id: askThread.id })
  ).at(0)
  if (!thread) throw new Error('no thread')
  await db
    .insert(askTurn)
    .values({ threadId: thread.id, role: 'user', bodyMd: QUESTION })
  const calls: Array<AskCall> = [
    { tool: 'web_search', state: 'done', input: QUESTION, found: 5 },
    {
      tool: 'show_companies',
      state: 'done',
      input: '',
      found: table.rows.length,
      find: table,
    },
  ]
  const answer = (
    await db
      .insert(askTurn)
      .values({
        threadId: thread.id,
        role: 'assistant',
        bodyMd: 'Five operators.',
        calls,
        state: 'answered',
      })
      .returning({ id: askTurn.id })
  ).at(0)
  if (!answer) throw new Error('no answer')
  return { threadId: thread.id, turnId: answer.id }
}

const counts = async () => {
  const of = async (
    table:
      | typeof spaceWatch
      | typeof suggestion
      | typeof space
      | typeof entity
      | typeof spaceWatchDismissal
      | typeof activity,
  ) => (await db.select({ n: count() }).from(table)).at(0)?.n ?? 0
  return {
    watches: await of(spaceWatch),
    suggestions: await of(suggestion),
    spaces: await of(space),
    entities: await of(entity),
    dismissals: await of(spaceWatchDismissal),
    activity: await of(activity),
  }
}

const openCardsUnder = (spaceId: string) =>
  db
    .select({
      domain: sql<string>`${suggestion.payload} ->> 'domain'`,
      watchIds: sql<Array<string>>`${suggestion.payload} -> 'watchIds'`,
    })
    .from(suggestion)
    .where(
      and(
        eq(suggestion.kind, 'add_record'),
        eq(suggestion.status, 'open'),
        sql`${suggestion.payload} ->> 'spaceId' = ${spaceId}`,
      ),
    )

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected a refusal')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

describe('Save as watch', () => {
  it('writes one watch; untouched rows become add_record cards, the added and dismissed rows nothing', async () => {
    const exa = await anEngine()
    const ops = await aSpace('Property ops')
    const table: AskFindTable = {
      space: ops,
      rows: [
        row('Added Co', 'added-co.in', exa),
        row('Dismissed Co', 'dismissed-co.in', exa),
        row('Alpha Estates', 'alpha-estates.in', exa),
        row('Beta Homes', 'beta-homes.in', exa),
        row('Gamma Living', 'gamma-living.in', exa),
      ],
      hidden: 0,
    }
    const { threadId, turnId } = await aFindTurn(table)
    await run(addFindRowProgram(me, turnId, 'added-co.in'))
    await run(dismissFindRowProgram(me, turnId, 'dismissed-co.in'))
    const before = await counts()

    const saved = await run(
      saveFindAsWatchProgram(me, {
        turnId,
        callIndex: 1,
        space: { id: ops.id },
        integrationId: exa,
        values: { criteria: QUESTION, cap: '25' },
        cadenceMinutes: 10080,
      }),
    )
    if (saved.status !== 'saved') throw new Error('expected a save')
    expect(saved).toMatchObject({
      spaceId: ops.id,
      spaceName: 'Property ops',
      cards: 3,
    })

    const watches = await db
      .select()
      .from(spaceWatch)
      .where(eq(spaceWatch.spaceId, ops.id))
    expect(watches).toHaveLength(1)
    expect(watches.at(0)).toMatchObject({
      id: saved.watchId,
      integrationId: exa,
      settings: { criteria: QUESTION, cap: 25 },
      cadenceMinutes: 10080,
      createdBy: me,
    })

    const cards = await openCardsUnder(ops.id)
    expect(cards.map((c) => c.domain).sort()).toEqual([
      'alpha-estates.in',
      'beta-homes.in',
      'gamma-living.in',
    ])
    for (const c of cards) expect(c.watchIds).toEqual([saved.watchId])

    const after = await counts()
    expect(after).toEqual({
      ...before,
      watches: before.watches + 1,
      suggestions: before.suggestions + 3,
    })
    // The dismissal stands and nothing was proposed for the added row.
    expect(
      await db
        .select()
        .from(spaceWatchDismissal)
        .where(eq(spaceWatchDismissal.spaceId, ops.id)),
    ).toMatchObject([{ domain: 'dismissed-co.in' }])

    // The thread's line, then the watch gone.
    const tableOf = async () =>
      (await run(getThreadProgram(me, threadId))).turns
        .find((t) => t.id === turnId)
        ?.calls.at(1)?.find?.savedWatch
    expect(await tableOf()).toEqual({
      id: saved.watchId,
      spaceId: ops.id,
      spaceName: 'Property ops',
    })
    await db.delete(spaceWatch).where(eq(spaceWatch.id, saved.watchId))
    expect(await tableOf()).toMatchObject({ deleted: true })
  })

  it('refuses the same space, engine and settings as the watch it is, writing nothing', async () => {
    const exa = await anEngine()
    const ops = await aSpace('Property ops', QUESTION)
    const { turnId } = await aFindTurn({
      space: ops,
      rows: [row('Alpha Estates', 'alpha-estates.in', exa)],
      hidden: 0,
    })
    const input = {
      turnId,
      callIndex: 1,
      space: { id: ops.id },
      integrationId: exa,
      // Equal to the criteria: saved blank, like the space page's Add watch.
      values: { criteria: QUESTION, cap: '25' },
      cadenceMinutes: 10080,
    }
    const first = await run(saveFindAsWatchProgram(me, input))
    if (first.status !== 'saved') throw new Error('expected a save')
    const stored = (
      await db
        .select({ settings: spaceWatch.settings })
        .from(spaceWatch)
        .where(eq(spaceWatch.id, first.watchId))
    ).at(0)
    expect(stored?.settings).toEqual({ cap: 25 })
    const callsBefore = (
      await db
        .select({ calls: askTurn.calls })
        .from(askTurn)
        .where(eq(askTurn.id, turnId))
    ).at(0)?.calls
    const before = await counts()

    const again = await run(
      saveFindAsWatchProgram(me, {
        ...input,
        values: { criteria: '', cap: '25' },
        cadenceMinutes: null,
      }),
    )
    expect(again).toEqual({
      status: 'exists',
      watchId: first.watchId,
      spaceId: ops.id,
      spaceName: 'Property ops',
    })
    expect(await counts()).toEqual(before)
    expect(
      (
        await db
          .select({ calls: askTurn.calls })
          .from(askTurn)
          .where(eq(askTurn.id, turnId))
      ).at(0)?.calls,
    ).toEqual(callsBefore)
  })

  it('from an unscoped turn creates the space named from the question and files the cards under it', async () => {
    const exa = await anEngine()
    const { turnId } = await aFindTurn({
      space: null,
      rows: [
        row('Alpha Estates', 'alpha-estates.in', exa),
        row('Beta Homes', 'beta-homes.in', exa),
      ],
      hidden: 0,
    })
    const saved = await run(
      saveFindAsWatchProgram(me, {
        turnId,
        callIndex: 1,
        space: { create: 'Property management operators in Pune' },
        integrationId: exa,
        values: { criteria: QUESTION, cap: '10' },
        cadenceMinutes: 10080,
      }),
    )
    if (saved.status !== 'saved') throw new Error('expected a save')
    const made = (
      await db
        .select({ name: entity.canonicalName })
        .from(entity)
        .where(eq(entity.id, saved.spaceId))
    ).at(0)
    expect(made?.name).toBe('Property management operators in Pune')
    expect(saved.cards).toBe(2)
    expect(await openCardsUnder(saved.spaceId)).toHaveLength(2)
  })

  it('refuses a turn that is not the reader’s and settings the schema refuses, writing nothing', async () => {
    const exa = await anEngine()
    const ops = await aSpace('Property ops')
    const { turnId } = await aFindTurn({
      space: ops,
      rows: [row('Alpha Estates', 'alpha-estates.in', exa)],
      hidden: 0,
    })
    const before = await counts()
    const bad = await Effect.runPromiseExit(
      saveFindAsWatchProgram(me, {
        turnId,
        callIndex: 1,
        space: { id: ops.id },
        integrationId: exa,
        values: { criteria: QUESTION, cap: '500' },
        cadenceMinutes: 10080,
      }),
    )
    expect(failureOf(bad)).toMatchObject({
      errors: { cap: 'must be between 1 and 100' },
    })
    const wrongTable = await Effect.runPromiseExit(
      saveFindAsWatchProgram(me, {
        turnId,
        callIndex: 0,
        space: { id: ops.id },
        integrationId: exa,
        values: { criteria: QUESTION, cap: '5' },
        cadenceMinutes: 10080,
      }),
    )
    expect(failureOf(wrongTable)).toMatchObject({
      message: 'That table is no longer in this thread',
    })
    expect(await counts()).toEqual(before)
  })
})
