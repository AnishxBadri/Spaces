import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiRoute,
  aiRun,
  aiUsage,
  attribute,
  credential,
  suggestion,
  view,
  workspace,
} from '@spaces/db/schema'
import type { Condition } from '@spaces/core/views/filter'
import { optionProposalLine } from '@spaces/core/ai/attribute-ai'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { enqueued } from '#web/test/queue-stub'
import { storeCredential } from '@spaces/core/writes/vault'
import { attributeRunProgram } from '#web/lib/ai/attribute-run'
import {
  columnRunKey,
  columnRunProgram,
  estimateColumnRunProgram,
  isColumnRunTask,
  pressColumnRunProgram,
} from '#web/lib/ai/column-run'
import { acceptColumnProgram, proposeProgram } from '#web/lib/ai/propose'
import { setAiRouteProgram } from '#web/lib/ai/route'
import {
  createObjectProgram,
  createRecordProgram,
} from '@spaces/core/writes/attributes/object-registry'
import { createAttributeProgram } from '@spaces/core/writes/attributes/create'
import { updateAttributeProgram } from '@spaces/core/writes/attributes/update'
import { listInboxProgram } from '#web/lib/inbox/queue'
import { JobPermanent } from '../run-job'
import { runAttributeColumnRun } from './attribute-column-run'

vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

/**
 * SPA-122, the column run end to end on a custom "Fund" object: the
 * estimate counted in SQL over a saved view's conditions minus the rows
 * already proposed, the job walking the view a page at a time through an
 * injected model (`MockLanguageModelV4`, no network), one run whose steps
 * are the rows and whose id every suggestion carries, the daily cap
 * stopping it with rows done and left, /inbox grouping the run under one
 * header whose "Accept all" goes through `acceptColumnProgram`, and a view
 * the compiler cannot express refused rather than run over a partial where.
 */

const USER = FIXTURE_ACTOR.id
const ME = { type: 'user', id: USER } as const

/** 40 in + 10 out: 50 tokens a call, so a daily cap of 100 allows two. */
function mockModel() {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: () =>
      Promise.resolve({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              why_now: {
                value: 'The window is open.',
                refs: [],
                confidence: 0.6,
              },
              reason: 'Read from the record.',
            }),
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 40,
            noCache: 40,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      }),
  })
}

async function routeLanes() {
  await storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: 'sk-ant-test-column-run',
    meta: {},
    createdBy: USER,
  })
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'synthesize',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

async function capAt(dailyTokens: number) {
  const settings = { ai_caps: { daily_tokens: dailyTokens } }
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

let fundObject: string
let city: string
let whyNow: string
let vintage: string
/** Five Bay Area funds, oldest first, and two in New York. */
let bay: Array<string>
let nyc: Array<string>
let screening: string

const saveView = async (name: string, filter: Array<Condition>) =>
  (
    await db
      .insert(view)
      .values({
        surface: 'object',
        objectId: fundObject,
        name,
        filter,
        visibility: 'shared',
        createdBy: USER,
      })
      .returning({ id: view.id })
  )[0].id

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(credential).where(isNotNull(credential.id))
  await db.delete(workspace).where(eq(workspace.id, 1))
  await db.delete(aiUsage).where(lte(aiUsage.at, new Date()))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const tag = Math.random().toString(36).slice(2, 8)
  fundObject = (
    await Effect.runPromise(
      createObjectProgram({
        singular: `Fund ${tag}`,
        plural: `Funds ${tag}`,
        createdBy: USER,
      }),
    )
  ).id
  const attr = (name: string, type: 'text' | 'number') =>
    Effect.runPromise(
      createAttributeProgram({
        objectId: fundObject,
        name,
        type,
        createdBy: USER,
      }),
    ).then((a) => a.id)
  city = await attr('City', 'text')
  whyNow = await attr('Why now?', 'text')
  vintage = await attr('Vintage', 'number')
  await Effect.runPromise(
    updateAttributeProgram({
      id: whyNow,
      config: { ai: { mode: 'prompt', prompt: 'Why is {{city}} right now?' } },
    }),
  )
  const record = (name: string, where: string) =>
    Effect.runPromise(
      createRecordProgram({
        objectId: fundObject,
        name: `${name} ${tag}`,
        values: { city: where },
        actor: ME,
        source: 'manual',
      }),
    ).then((r) => r.id)
  bay = []
  for (const n of ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm'])
    bay.push(await record(n, 'Bay Area'))
  nyc = [await record('Fir', 'New York'), await record('Gum', 'New York')]
  screening = await saveView('Screening · Bay Area', [
    { slug: 'city', op: 'is', value: 'Bay Area' },
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
})

const patchesOf = (entityId: string) =>
  db
    .select()
    .from(suggestion)
    .where(
      and(
        eq(suggestion.entityId, entityId),
        eq(suggestion.kind, 'attribute_patch'),
      ),
    )

/** One Bay Area row proposed by hand before the run, outside any run. */
const proposeByHand = (entityId: string) =>
  Effect.runPromise(
    proposeProgram({
      entityId,
      kind: 'attribute_patch',
      payload: {
        why_now: { value: 'Proposed earlier.', refs: [], confidence: 0.5 },
      },
      proposedBy: ME,
    }),
  )

describe('the estimate', () => {
  it('is the SQL count over the view’s conditions minus rows with an open proposal for the attribute', async () => {
    await proposeByHand(bay[0])
    // A registry proposal naming the attribute counts as proposed too.
    await Effect.runPromise(
      proposeProgram({
        entityId: bay[1],
        kind: 'attribute_patch',
        payload: {},
        rationale: optionProposalLine({
          slug: 'why_now',
          name: 'Why now?',
          label: 'Hot',
        }),
        proposedBy: ME,
      }),
    )
    // A New York row proposed is outside the view, so it changes nothing.
    await proposeByHand(nyc[0])
    const estimate = await Effect.runPromise(
      estimateColumnRunProgram(screening, whyNow, USER),
    )
    expect(estimate).toEqual({
      ok: true,
      viewName: 'Screening · Bay Area',
      attributeName: 'Why now?',
      total: 5,
      proposed: 2,
      calls: 3,
      perCall: null,
      tokens: null,
    })
  })

  it('prices a call from the attribute’s last run once there is one', async () => {
    await routeLanes()
    await Effect.runPromise(
      attributeRunProgram({
        entityId: nyc[0],
        attributeId: whyNow,
        userId: USER,
        model: mockModel(),
      }),
    )
    const estimate = await Effect.runPromise(
      estimateColumnRunProgram(screening, whyNow, USER),
    )
    expect(estimate).toMatchObject({
      ok: true,
      calls: 5,
      perCall: { tokens: 50, from: 'attribute' },
      tokens: 250,
    })
  })

  it('an attribute with no ai config is refused', async () => {
    const estimate = await Effect.runPromise(
      estimateColumnRunProgram(screening, vintage, USER),
    )
    expect(estimate).toEqual({
      ok: false,
      reason: 'Vintage is not an AI attribute',
    })
  })
})

describe('a view the compiler cannot express', () => {
  it('is refused at the estimate, the press and the job — never run over a partial where', async () => {
    await routeLanes()
    const stale = await saveView('Stale', [
      { slug: 'city', op: 'is', value: 'Bay Area' },
      { slug: 'vintage', op: 'gt', value: 2020 },
    ])
    await Effect.runPromise(
      updateAttributeProgram({ id: vintage, archived: true }),
    )
    const estimate = await Effect.runPromise(
      estimateColumnRunProgram(stale, whyNow, USER),
    )
    expect(estimate.ok).toBe(false)
    if (!estimate.ok) expect(estimate.reason).toMatch(/“Vintage”.*archived/)

    const pressed = await Effect.runPromise(
      pressColumnRunProgram(stale, whyNow, USER),
    )
    expect(pressed.status).toBe('refused')
    expect(enqueued).toEqual([])

    const model = mockModel()
    const runsBefore = (await db.select().from(aiRun)).length
    const job = await Effect.runPromise(
      Effect.result(
        runAttributeColumnRun(
          { viewId: stale, attributeId: whyNow, userId: USER },
          { model },
        ),
      ),
    )
    expect(job._tag).toBe('Failure')
    if (job._tag === 'Failure') expect(job.failure).toBeInstanceOf(JobPermanent)
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await db.select().from(aiRun)).toHaveLength(runsBefore)
  })
})

describe('the press', () => {
  it('queues one job keyed on (view, attribute); a second press is already running', async () => {
    await routeLanes()
    expect(
      await Effect.runPromise(pressColumnRunProgram(screening, whyNow, USER)),
    ).toEqual({ status: 'queued', calls: 5 })
    expect(enqueued).toEqual([
      {
        name: QUEUES.attributeColumnRun,
        data: { viewId: screening, attributeId: whyNow, userId: USER },
        options: { singletonKey: columnRunKey(screening, whyNow) },
      },
    ])
    expect(
      await Effect.runPromise(pressColumnRunProgram(screening, whyNow, USER)),
    ).toEqual({ status: 'already-running' })
  })

  it('an unrouted lane is refused before anything is queued', async () => {
    const pressed = await Effect.runPromise(
      pressColumnRunProgram(screening, whyNow, USER),
    )
    expect(pressed.status).toBe('refused')
    expect(enqueued).toEqual([])
  })
})

describe('the run', () => {
  it('walks the view by page, skips the row already proposed, and threads one run through every row', async () => {
    await routeLanes()
    await proposeByHand(bay[0])
    const model = mockModel()
    const result = await Effect.runPromise(
      columnRunProgram({
        viewId: screening,
        attributeId: whyNow,
        userId: USER,
        model,
        pageSize: 2,
      }),
    )
    // Four rows to run, two a page: two page queries, never the whole view.
    expect(result).toMatchObject({
      done: 4,
      proposed: 4,
      failed: [],
      left: 0,
      stopped: null,
      pages: 2,
    })
    expect(model.doGenerateCalls).toHaveLength(4)
    // Skipped, not re-proposed; the rows outside the view are untouched.
    expect(await patchesOf(bay[0])).toHaveLength(1)
    for (const id of nyc) expect(await patchesOf(id)).toEqual([])

    const runId = result.runId
    expect(runId).not.toBeNull()
    const written = await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.runId, runId ?? ''))
    expect(written.map((s) => s.entityId).sort()).toEqual(bay.slice(1).sort())
    const run = (
      await db
        .select()
        .from(aiRun)
        .where(eq(aiRun.id, runId ?? ''))
    ).at(0)
    expect(run?.status).toBe('done')
    expect(isColumnRunTask(run?.task ?? '')).toBe(true)
    expect(run?.task).toContain('Why now?')
    expect(run?.task).toContain('Screening · Bay Area')
    // One step per row, each citing the suggestion it wrote.
    expect(run?.steps.map((s) => s.output_ref).sort()).toEqual(
      written.map((s) => `suggestion:${s.id}`).sort(),
    )
    expect(run?.tokensIn).toBe(160)
    const usage = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.runId, runId ?? ''))
    expect(usage).toHaveLength(4)
  })

  it('the daily cap stops it with rows done and left; /inbox groups the run under one header whose Accept all takes only the run', async () => {
    await routeLanes()
    await proposeByHand(bay[0])
    await capAt(100)
    const model = mockModel()
    const result = await Effect.runPromise(
      columnRunProgram({
        viewId: screening,
        attributeId: whyNow,
        userId: USER,
        model,
        pageSize: 2,
      }),
    )
    expect(result).toMatchObject({ done: 2, proposed: 2, left: 2 })
    expect(result.stopped).toMatch(/AI cap/)
    expect(model.doGenerateCalls).toHaveLength(2)
    const run = (
      await db
        .select()
        .from(aiRun)
        .where(eq(aiRun.id, result.runId ?? ''))
    ).at(0)
    expect(run?.status).toBe('failed')
    expect(run?.error).toContain('Stopped with 2 rows done, 2 left.')

    const rows = await Effect.runPromise(listInboxProgram())
    const group = rows.find((r) => r.kind === 'column_run')
    expect(group?.kind).toBe('column_run')
    if (group?.kind !== 'column_run') return
    expect(group.id).toBe(result.runId)
    expect(group.attributeSlug).toBe('why_now')
    expect(group.run.status).toBe('failed')
    expect(group.run.error).toContain('2 rows done, 2 left')
    expect(group.run.rowsRun).toBe(2)
    expect(group.cards).toHaveLength(2)
    // The hand proposal is outside the run: its own card, not the group's.
    expect(rows.some((r) => r.kind === 'suggestion' && r.id === bay[0])).toBe(
      true,
    )

    // A registry proposal in the run is not something Accept all touches.
    const registry = await Effect.runPromise(
      proposeProgram({
        entityId: bay[4],
        kind: 'attribute_patch',
        payload: {},
        rationale: optionProposalLine({
          slug: 'why_now',
          name: 'Why now?',
          label: 'Hot',
        }),
        runId: result.runId ?? '',
        proposedBy: ME,
      }),
    )
    const outcomes = await Effect.runPromise(
      acceptColumnProgram({
        attributeSlug: 'why_now',
        actorId: USER,
        runId: result.runId ?? '',
      }),
    )
    expect(outcomes).toHaveLength(2)
    expect(outcomes.every((o) => o.ok)).toBe(true)
    const open = await db
      .select({ id: suggestion.id })
      .from(suggestion)
      .where(
        and(
          eq(suggestion.status, 'open'),
          inArray(suggestion.entityId, [...bay, ...nyc]),
        ),
      )
    expect(open.map((o) => o.id).sort()).toEqual(
      [registry.id, (await patchesOf(bay[0]))[0].id].sort(),
    )
  })

  it('a per-cell press is its own one-step run', async () => {
    await routeLanes()
    const r = await Effect.runPromise(
      attributeRunProgram({
        entityId: bay[0],
        attributeId: whyNow,
        userId: USER,
        model: mockModel(),
      }),
    )
    const s = r.suggestions[0]
    expect(s.runId).not.toBeNull()
    const run = (
      await db
        .select()
        .from(aiRun)
        .where(eq(aiRun.id, s.runId ?? ''))
    ).at(0)
    expect(run?.status).toBe('done')
    expect(run?.task).toBe('AI attribute · Why now?')
    expect(run?.steps).toHaveLength(1)
    expect(run?.steps[0].output_ref).toBe(`suggestion:${s.id}`)
  })

  it('the job completes through the wrapper with an injected model', async () => {
    await routeLanes()
    const model = mockModel()
    await Effect.runPromise(
      runAttributeColumnRun(
        { viewId: screening, attributeId: whyNow, userId: USER },
        { model },
      ),
    )
    expect(model.doGenerateCalls).toHaveLength(5)
    // The view's slugs are the registry's: `City` is `city`, the condition's.
    const cityRow = (
      await db.select().from(attribute).where(eq(attribute.id, city))
    ).at(0)
    expect(cityRow?.slug).toBe('city')
  })
})
