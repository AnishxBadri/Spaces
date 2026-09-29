import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  activity,
  aiRoute,
  credential,
  entity,
  entitySpace,
  space,
  suggestion,
  workspace,
} from '@spaces/db/schema'
import { readSpaceTagPayload } from '@spaces/core/ai/space-tag'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { storeCredential } from '@spaces/core/writes/vault'
import {
  keepValid,
  pressSuggestSpacesProgram,
  suggestSpacesMessage,
  suggestSpacesProgram,
  suggestSpacesStatusProgram,
} from '#/lib/ai/suggest-spaces'
import { acceptProgram, rejectProgram } from '#/lib/ai/propose'
import { isLaneRoutedProgram, setAiRouteProgram } from '#/lib/ai/route'
import { setEntitySensitiveProgram } from '#/lib/ai/sensitivity-for'
import { JobPermanent } from '../run-job'
import { runSuggestSpaces } from './suggest-spaces'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * SPA-103, the lane end to end: the press, the run, the inbox decision.
 * Beside the worker because it runs the job, as kind classify's test does.
 * Through an injected model (`MockLanguageModelV4`): the route, the
 * sensitivity read, the context assembly, the suggestion rows, the accept
 * and the reject are all real; nothing reaches a network.
 */

const USER = FIXTURE_ACTOR.id
const DECIDER = { type: 'user', id: USER } as const

type Answer = {
  spaces: Array<{ spaceId: string; confidence: number }>
  reason: string
}

function mockModel(answer: Answer) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(answer) }],
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

async function routeClassify(sensitivity: 'normal' | 'sensitive' = 'normal') {
  await storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: `sk-ant-test-spaces-${sensitivity}`,
    meta: {},
    createdBy: USER,
  })
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'classify',
      sensitivity,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

async function mkEntity(kind: 'space' | 'company', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('insert returned nothing')
  return row.id
}

async function mkSpace(name: string, path: string, parentId: string | null) {
  const id = await mkEntity('space', name)
  const slug = path.split('.').at(-1) ?? path
  await db.insert(space).values({ entityId: id, parentId, slug, path })
  return id
}

const run = (entityId: string, answer: Answer) => {
  const model = mockModel(answer)
  return Effect.runPromise(
    suggestSpacesProgram({ entityId, userId: USER, model }),
  ).then((result) => ({ result, model }))
}

const spaceTagsOf = (entityId: string) =>
  db
    .select()
    .from(suggestion)
    .where(
      and(eq(suggestion.entityId, entityId), eq(suggestion.kind, 'space_tag')),
    )

const tagsOf = (entityId: string) =>
  db.select().from(entitySpace).where(eq(entitySpace.entityId, entityId))

let energy: string
let storage: string
let grid: string
let aero: string
let company: string

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(credential).where(isNotNull(credential.id))
  await db.delete(workspace).where(eq(workspace.id, 1))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const tag = Math.random().toString(36).slice(2, 8)
  energy = await mkSpace('Energy', `en_${tag}`, null)
  storage = await mkSpace('Storage', `en_${tag}.storage`, energy)
  grid = await mkSpace('Grid batteries', `en_${tag}.storage.grid`, storage)
  aero = await mkSpace('Aerospace', `aero_${tag}`, null)
  company = await mkEntity('company', `Voltstack ${tag}`)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the vocabulary comes from the space table', () => {
  it('the enum is the live tree’s ids, minus what the record carries, and the task names each by path', async () => {
    await routeClassify()
    await db
      .insert(entitySpace)
      .values({ entityId: company, spaceId: aero, source: 'manual' })
    const { model } = await run(company, { spaces: [], reason: 'none' })
    expect(model.doGenerateCalls).toHaveLength(1)
    const call = model.doGenerateCalls[0]
    const format = call.responseFormat
    const schema = format?.type === 'json' ? format.schema : undefined
    const live = await db.select({ id: space.entityId }).from(space)
    const expected = live.map((s) => s.id).filter((id) => id !== aero)
    const text = JSON.stringify(schema)
    for (const id of expected) expect(text).toContain(id)
    expect(text).not.toContain(aero)
    expect(JSON.stringify(call.prompt)).toContain(
      `${grid} — Energy / Storage / Grid batteries`,
    )
  })
})

describe('suggest spaces — the run', () => {
  it('writes one space_tag suggestion per proposed space, with its confidence', async () => {
    await routeClassify()
    const { result } = await run(company, {
      spaces: [
        { spaceId: grid, confidence: 0.82 },
        { spaceId: energy, confidence: 0.6 },
      ],
      reason: 'Sells grid-scale battery systems.',
    })
    expect(result.skipped).toBeNull()
    expect(result.suggestions).toHaveLength(2)
    const rows = await spaceTagsOf(company)
    const payloads = rows.map((r) => readSpaceTagPayload(r.payload))
    expect(payloads).toEqual(
      expect.arrayContaining([
        {
          spaceId: grid,
          label: 'Energy / Storage / Grid batteries',
          confidence: 0.82,
        },
        { spaceId: energy, label: 'Energy', confidence: 0.6 },
      ]),
    )
    for (const r of rows) {
      expect(r.status).toBe('open')
      expect(r.proposedByType).toBe('user')
      expect(r.rationale).toContain('Sells grid-scale battery systems.')
    }
    // Nothing is tagged until a person accepts.
    expect(await tagsOf(company)).toEqual([])
  })

  it('drops an id absent from the tree, a space already carried and a repeat — counted in the rationale, never written, never raising', async () => {
    await routeClassify()
    await db
      .insert(entitySpace)
      .values({ entityId: company, spaceId: aero, source: 'manual' })
    const ghost = '00000000-0000-4000-8000-000000000000'
    const { result } = await run(company, {
      spaces: [
        { spaceId: ghost, confidence: 0.9 },
        { spaceId: aero, confidence: 0.9 },
        { spaceId: storage, confidence: 0.7 },
        { spaceId: storage, confidence: 0.5 },
      ],
      reason: 'Battery storage.',
    })
    expect(result.suggestions).toHaveLength(1)
    expect(result.dropped.map((d) => d.spaceId)).toEqual([ghost, aero, storage])
    const rows = await spaceTagsOf(company)
    expect(rows).toHaveLength(1)
    expect(readSpaceTagPayload(rows[0].payload)?.spaceId).toBe(storage)
    expect(rows[0].rationale).toContain('Dropped 3 answers')
    expect(rows[0].rationale).toContain('not a space in the tree')
    expect(rows[0].rationale).toContain('already carries')
  })

  it('with nothing proposable left it writes nothing, and does not raise', async () => {
    await routeClassify()
    const { result } = await run(company, {
      spaces: [{ spaceId: 'not-a-space', confidence: 1 }],
      reason: 'x',
    })
    expect(result.suggestions).toEqual([])
    expect(result.skipped).toContain('Dropped 1 answer')
    expect(await spaceTagsOf(company)).toEqual([])
  })

  it('keepValid is the rule, pure', () => {
    const tree = [
      { id: 'a', path: 'a', label: 'A' },
      { id: 'b', path: 'a.b', label: 'A / B' },
      { id: 'c', path: 'c', label: 'C' },
    ]
    const { picks, dropped } = keepValid(
      [
        { spaceId: 'b', confidence: 0.5 },
        { spaceId: 'a' },
        { spaceId: 'c', confidence: 0.4 },
        { spaceId: 'z', confidence: 0.4 },
      ],
      {
        tree,
        carried: new Set(['a']),
        decided: new Map([['c', 'rejected']]),
      },
    )
    expect(picks).toEqual([{ spaceId: 'b', label: 'A / B', confidence: 0.5 }])
    expect(dropped.map((d) => d.why)).toEqual([
      'A is a space the record already carries',
      'C was already proposed (rejected)',
      '"z" is not a space in the tree',
    ])
  })
})

describe('suggest spaces — the decision', () => {
  it('accepting writes entity_space with source ai, the confidence and the accepter — through the one insert', async () => {
    await routeClassify()
    const { result } = await run(company, {
      spaces: [
        { spaceId: grid, confidence: 0.82 },
        { spaceId: aero, confidence: 0.3 },
        { spaceId: energy, confidence: 0.55 },
      ],
      reason: 'Batteries.',
    })
    const byspace = new Map(
      result.suggestions.map((s) => [
        readSpaceTagPayload(s.payload)?.spaceId,
        s.id,
      ]),
    )
    const gridId = byspace.get(grid)
    const energyId = byspace.get(energy)
    const aeroId = byspace.get(aero)
    if (!gridId || !energyId || !aeroId) throw new Error('missing proposals')

    const accepted = await Effect.runPromise(acceptProgram(gridId, DECIDER))
    expect(accepted).toMatchObject({
      kind: 'space_tag',
      spaceId: grid,
      tagged: true,
    })
    await Effect.runPromise(acceptProgram(energyId, DECIDER))
    await Effect.runPromise(rejectProgram(aeroId, DECIDER))

    const tags = await tagsOf(company)
    expect(tags).toHaveLength(2)
    const gridTag = tags.find((t) => t.spaceId === grid)
    expect(gridTag?.source).toBe('ai')
    expect(gridTag?.confidence).toBeCloseTo(0.82)
    expect(gridTag?.createdBy).toBe(USER)
    expect(tags.some((t) => t.spaceId === aero)).toBe(false)

    const logged = await db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.subjectEntityId, company),
          eq(activity.verb, 'space.tagged'),
        ),
      )
    expect(logged).toHaveLength(2)
    expect(logged.every((a) => a.actorId === USER)).toBe(true)
  })

  it('a space accepted after a hand tag keeps the hand tag and closes the suggestion', async () => {
    await routeClassify()
    const { result } = await run(company, {
      spaces: [{ spaceId: grid, confidence: 0.8 }],
      reason: 'x',
    })
    await db
      .insert(entitySpace)
      .values({ entityId: company, spaceId: grid, source: 'manual' })
    const accepted = await Effect.runPromise(
      acceptProgram(result.suggestions[0].id, DECIDER),
    )
    expect(accepted).toMatchObject({ kind: 'space_tag', tagged: false })
    const tags = await tagsOf(company)
    expect(tags).toHaveLength(1)
    expect(tags[0].source).toBe('manual')
  })

  it('rejecting keeps that space out: a later run neither offers it nor writes it', async () => {
    await routeClassify()
    const first = await run(company, {
      spaces: [{ spaceId: aero, confidence: 0.4 }],
      reason: 'x',
    })
    await Effect.runPromise(
      rejectProgram(first.result.suggestions[0].id, DECIDER),
    )
    const second = await run(company, {
      spaces: [
        { spaceId: aero, confidence: 0.9 },
        { spaceId: storage, confidence: 0.7 },
      ],
      reason: 'y',
    })
    const format = second.model.doGenerateCalls[0].responseFormat
    const schema = format?.type === 'json' ? format.schema : undefined
    expect(JSON.stringify(schema)).not.toContain(aero)
    expect(second.result.dropped).toEqual([
      { spaceId: aero, why: 'Aerospace was already proposed (rejected)' },
    ])
    const rows = await spaceTagsOf(company)
    expect(
      rows.filter((r) => readSpaceTagPayload(r.payload)?.spaceId === aero),
    ).toHaveLength(1)
    expect(await tagsOf(company)).toEqual([])
  })

  it('a space tag is accepted whole, never by field', async () => {
    await routeClassify()
    const { result } = await run(company, {
      spaces: [{ spaceId: grid, confidence: 0.8 }],
      reason: 'x',
    })
    const refused = await Effect.runPromise(
      Effect.result(acceptProgram(result.suggestions[0].id, DECIDER, ['x'])),
    )
    expect(refused._tag).toBe('Failure')
  })
})

describe('suggest spaces — the press', () => {
  it('with the classify lane unrouted the gate is closed and a press is refused', async () => {
    expect(
      await Effect.runPromise(isLaneRoutedProgram('classify', USER)),
    ).toEqual({ normal: false, sensitive: false })
    const pressed = await Effect.runPromise(
      pressSuggestSpacesProgram(company, USER),
    )
    expect(pressed.status).toBe('refused')
    expect(enqueued).toEqual([])
  })

  it('routed, it enqueues one job keyed on the record; a second press is already running', async () => {
    await routeClassify()
    expect(
      await Effect.runPromise(isLaneRoutedProgram('classify', USER)),
    ).toMatchObject({ normal: true })
    expect(
      await Effect.runPromise(pressSuggestSpacesProgram(company, USER)),
    ).toEqual({ status: 'queued' })
    expect(enqueued).toEqual([
      {
        name: QUEUES.suggestSpaces,
        data: { entityId: company, userId: USER },
        options: { singletonKey: company },
      },
    ])
    expect(
      await Effect.runPromise(pressSuggestSpacesProgram(company, USER)),
    ).toEqual({ status: 'already-running' })
    expect(
      await Effect.runPromise(suggestSpacesStatusProgram(company)),
    ).toEqual({ state: 'running' })
  })

  it('a record under a sensitive space on a cloud-routed lane is refused, naming the space', async () => {
    await routeClassify('normal')
    await routeClassify('sensitive')
    await db
      .insert(entitySpace)
      .values({ entityId: company, spaceId: grid, source: 'manual' })
    await Effect.runPromise(setEntitySensitiveProgram(energy, true))

    const pressed = await Effect.runPromise(
      pressSuggestSpacesProgram(company, USER),
    )
    expect(pressed.status).toBe('refused')
    expect(pressed.status === 'refused' ? pressed.message : '').toContain(
      'Energy',
    )
    expect(enqueued).toEqual([])

    // And the run itself refuses the same way, before any model call.
    const model = mockModel({
      spaces: [{ spaceId: aero, confidence: 1 }],
      reason: 'x',
    })
    const ran = await Effect.runPromise(
      Effect.result(
        suggestSpacesProgram({ entityId: company, userId: USER, model }),
      ),
    )
    expect(ran._tag).toBe('Failure')
    if (ran._tag === 'Failure') {
      expect(ran.failure._tag).toBe('SensitiveRouteRefused')
      expect(suggestSpacesMessage(ran.failure)).toContain(
        'inherited from Energy',
      )
    }
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await spaceTagsOf(company)).toEqual([])
  })
})

describe('entity.suggest-spaces — the job', () => {
  it('fails permanently, with no network, when the lane is not routed', async () => {
    const exit = await Effect.runPromise(
      Effect.result(
        runSuggestSpaces(
          { entityId: company, userId: USER },
          { model: mockModel({ spaces: [], reason: 'x' }) },
        ),
      ),
    )
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      expect(exit.failure).toBeInstanceOf(JobPermanent)
      expect(exit.failure.reason).toContain('No model is routed')
    }
  })
})
