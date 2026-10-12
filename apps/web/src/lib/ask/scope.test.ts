import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  company,
  entity,
  entitySpace,
  objectDef,
  space,
  view,
} from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { setAiRouteProgram } from '#/lib/ai/route'
import { toolRegistry } from '#/lib/mcp/registry'
import { NO_SCOPE, entityChips, scopeQueryInput, scopeSentences } from './scope'
import type { TurnScope } from './scope'
import { askEvents } from './turn'
import type { AskEvent, AskScopeChip } from './types'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Scope chips narrow a turn: a space chip is query_records' default
 * condition with descendants, a view chip adds the view's conditions on its
 * object, and no chip reads the whole workspace. (D70, D71)
 */

const SPACE: TurnScope = {
  space: { id: '00000000-0000-4000-8000-0000000000a1', name: 'Hydrogen' },
  view: null,
}
const VIEW: TurnScope = {
  space: null,
  view: {
    name: 'Seed rounds',
    object: { slug: 'companies', singular: 'Company', plural: 'Companies' },
    conditions: [
      { slug: 'funding_stage', op: 'is', value: 'seed' },
      { slug: 'location', op: 'not_empty' },
    ],
  },
}

describe('scopeQueryInput', () => {
  it('adds the space with descendants unless the call names its own', () => {
    expect(scopeQueryInput({ object: 'companies' }, SPACE)).toEqual({
      object: 'companies',
      conditions: {
        space: { id: SPACE.space?.id, includeDescendants: true },
      },
    })
    const own = { object: 'deals', conditions: { space: { id: 'Other' } } }
    expect(scopeQueryInput(own, SPACE)).toEqual(own)
  })

  it('adds a view’s conditions on its object only, beside the call’s own', () => {
    expect(
      scopeQueryInput(
        { object: 'Companies', conditions: { funding_stage: 'series_a' } },
        VIEW,
      ),
    ).toEqual({
      object: 'Companies',
      conditions: {
        funding_stage: [
          { op: 'is', value: 'series_a' },
          { op: 'is', value: 'seed' },
        ],
        location: [{ op: 'not_empty' }],
      },
    })
    expect(scopeQueryInput({ object: 'people' }, VIEW)).toEqual({
      object: 'people',
      conditions: {},
    })
  })

  it('leaves an input alone with no scope, or one that is not an object', () => {
    expect(scopeQueryInput({ object: 'companies' }, NO_SCOPE)).toEqual({
      object: 'companies',
    })
    expect(scopeQueryInput('nonsense', SPACE)).toBe('nonsense')
    // Malformed conditions are the tool's to refuse, never quietly dropped.
    const bad = { object: 'companies', conditions: 'seed only' }
    expect(scopeQueryInput(bad, SPACE)).toBe(bad)
  })

  it('tells the model what narrows, and the whole workspace when nothing does', () => {
    expect(scopeSentences([], NO_SCOPE)).toEqual([
      'The reader is asking about the whole workspace.',
    ])
    const chips: Array<AskScopeChip> = [
      { kind: 'space', id: 's1', name: 'Hydrogen', href: '/spaces/s1' },
      { kind: 'view', id: 'v1', name: 'Seed rounds', href: null },
    ]
    expect(entityChips(chips).map((c) => c.id)).toEqual(['s1'])
    expect(scopeSentences(chips, { ...SPACE, view: VIEW.view })).toEqual([
      'The reader is asking about Hydrogen (space, id s1); start with get_context on it.',
      'query_records keeps to records filed in Hydrogen or a space below it.',
      'The reader is looking at the saved view “Seed rounds” of Companies: query_records on companies keeps to its rows.',
    ])
  })
})

// ---------------------------------------------------------------------------
// A turn, end to end

const usage = {
  inputTokens: {
    total: 30,
    noCache: 30,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
}

/** Calls one tool, then answers with what the prompt held. */
function agentModel(call: { toolName: string; input: unknown }) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async (options) => {
      if (options.prompt.at(-1)?.role === 'tool') {
        const chunks = [
          { type: 'text-start' as const, id: 't' },
          { type: 'text-delta' as const, id: 't', delta: 'Done.' },
          { type: 'text-end' as const, id: 't' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
          },
        ]
        return { stream: simulateReadableStream({ chunks }) }
      }
      const chunks = [
        {
          type: 'tool-call' as const,
          toolCallId: `call-${options.prompt.length}`,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
          usage,
        },
      ]
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
}

async function collect(events: AsyncIterable<AskEvent>) {
  const out: Array<AskEvent> = []
  for await (const e of events) out.push(e)
  return out
}

const companiesObject = async () => {
  const row = (
    await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, 'companies'))
  ).at(0)
  if (!row) throw new Error('the seed has a companies object')
  return row.id
}

async function aCompany(name: string, stage: string | null) {
  const [ent] = await db
    .insert(entity)
    .values({
      kind: 'company',
      canonicalName: name,
      objectId: await companiesObject(),
      values: stage === null ? {} : { funding_stage: stage },
    })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

async function aSpace(name: string, parent?: { id: string; path: string }) {
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'space', canonicalName: name })
    .returning({ id: entity.id })
  const slug = name.toLowerCase()
  const path = parent ? `${parent.path}.${slug}` : slug
  await db
    .insert(space)
    .values({ entityId: ent.id, parentId: parent?.id ?? null, slug, path })
  return { id: ent.id, path }
}

const file = (entityId: string, spaceId: string) =>
  db.insert(entitySpace).values({
    entityId,
    spaceId,
    source: 'manual',
    createdBy: FIXTURE_ACTOR.id,
  })

const valueOf = (events: ReadonlyArray<AskEvent>) => {
  const last = events.at(-1)
  if (last?.type !== 'end') throw new Error('the turn did not end')
  return last.turn
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a scoped turn', () => {
  it('a space chip makes query_records take the space with its descendants', async () => {
    await Effect.runPromise(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    const hydrogen = await aSpace('Hydrogen')
    const storage = await aSpace('Storage', hydrogen)
    await file(await aCompany('Electra', 'seed'), hydrogen.id)
    await file(await aCompany('Tankworks', null), storage.id)
    await aCompany('Elsewhere', 'seed')
    const spy = vi.spyOn(toolRegistry, 'call')
    const chip: AskScopeChip = {
      kind: 'space',
      id: hydrogen.id,
      name: 'Hydrogen',
      href: `/spaces/${hydrogen.id}`,
    }
    const turn = valueOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'Who is in this market?',
          scope: [chip],
          model: agentModel({
            toolName: 'query_records',
            input: { object: 'companies' },
          }),
        }),
      ),
    )
    expect(spy).toHaveBeenCalledWith(
      'query_records',
      expect.objectContaining({ userId: FIXTURE_ACTOR.id }),
      {
        object: 'companies',
        conditions: { space: { id: hydrogen.id, includeDescendants: true } },
      },
    )
    // Electra and Tankworks, below; never Elsewhere.
    expect(turn.calls.find((c) => c.tool === 'query_records')?.found).toBe(2)
    expect(turn.scope).toEqual([chip])
  })

  it('a view chip runs query_records with the view’s conditions; no chip reads everything', async () => {
    await Effect.runPromise(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    // The file's other test left three companies, none pre-seed.
    await aCompany('Seedy One', 'pre_seed')
    await aCompany('Seedy Two', 'pre_seed')
    await aCompany('Later', 'series_a')
    const [saved] = await db
      .insert(view)
      .values({
        surface: 'object',
        objectId: await companiesObject(),
        name: 'Seed rounds',
        filter: [{ slug: 'funding_stage', op: 'is', value: 'pre_seed' }],
        createdBy: FIXTURE_ACTOR.id,
      })
      .returning({ id: view.id })
    const spy = vi.spyOn(toolRegistry, 'call')
    const ask = async (scope: ReadonlyArray<AskScopeChip>) =>
      valueOf(
        await collect(
          askEvents({
            userId: FIXTURE_ACTOR.id,
            threadId: null,
            question: 'How many?',
            scope,
            model: agentModel({
              toolName: 'query_records',
              input: { object: 'companies' },
            }),
          }),
        ),
      )
    const viewed = await ask([
      {
        kind: 'view',
        id: saved.id,
        name: 'Seed rounds',
        href: `/companies?view=${saved.id}`,
      },
    ])
    expect(spy).toHaveBeenCalledWith('query_records', expect.anything(), {
      object: 'companies',
      conditions: { funding_stage: [{ op: 'is', value: 'pre_seed' }] },
    })
    expect(viewed.calls.find((c) => c.tool === 'query_records')?.found).toBe(2)
    // The view is no entity: the run names none.
    const whole = await ask([])
    expect(spy).toHaveBeenLastCalledWith('query_records', expect.anything(), {
      object: 'companies',
    })
    expect(whole.calls.find((c) => c.tool === 'query_records')?.found).toBe(6)
  })

  it('a space seed with a sensitive subspace turns the call sensitive', async () => {
    for (const [sensitivity, provider, model] of [
      ['normal', 'anthropic', 'claude-opus-5'],
      ['sensitive', 'ollama', 'llama3.2'],
    ] as const)
      await Effect.runPromise(
        setAiRouteProgram({ lane: 'synthesize', sensitivity, provider, model }),
      )
    const fuel = await aSpace('Fuel')
    const secret = await aSpace('Secret', fuel)
    await db
      .update(entity)
      .set({ sensitive: true })
      .where(eq(entity.id, secret.id))
    const events = await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'What do we believe here?',
        scope: [{ kind: 'space', id: fuel.id, name: 'Fuel', href: null }],
        model: agentModel({
          toolName: 'get_context',
          input: { entity: fuel.id },
        }),
      }),
    )
    const routes = events.flatMap((e) => (e.type === 'route' ? [e] : []))
    expect(routes.at(0)?.sensitive).toBe(false)
    expect(routes.at(-1)?.sensitive).toBe(true)
    expect(valueOf(events).route).toContain('answered locally by Ollama')
  })

  it('drops a chip that does not resolve, with a line, and the others still narrow', async () => {
    await Effect.runPromise(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    const wind = await aSpace('Wind')
    await file(await aCompany('Gusty', null), wind.id)
    const spy = vi.spyOn(toolRegistry, 'call')
    const gone = '00000000-0000-4000-8000-0000000000ff'
    const chips: Array<AskScopeChip> = [
      { kind: 'space', id: wind.id, name: 'Wind', href: null },
      { kind: 'view', id: gone, name: 'Old view', href: null },
      { kind: 'space', id: gone, name: 'Deleted space', href: null },
    ]
    const events = await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'Who is here?',
        scope: chips,
        model: agentModel({
          toolName: 'query_records',
          input: { object: 'companies' },
        }),
      }),
    )
    // The space that resolved still narrows every call.
    expect(spy).toHaveBeenCalledWith('query_records', expect.anything(), {
      object: 'companies',
      conditions: { space: { id: wind.id, includeDescendants: true } },
    })
    const turn = valueOf(events)
    expect(turn.calls.find((c) => c.tool === 'query_records')?.found).toBe(1)
    // Stored in the chips that resolved; each dropped one named once.
    expect(turn.scope).toEqual([chips[0]])
    expect(
      turn.calls.filter((c) => c.tool === 'scope').map((c) => c.reason),
    ).toEqual([
      'Old view dropped — no longer there',
      'Deleted space dropped — no longer there',
    ])
    expect(turn.state).toBe('answered')
  })

  it('a malformed condition is refused, not run without it', async () => {
    const sea = await aSpace('Sea')
    const scoped = scopeQueryInput(
      { object: 'companies', conditions: 'seed only' },
      { space: { id: sea.id, name: 'Sea' }, view: null },
    )
    const exit = await Effect.runPromiseExit(
      toolRegistry.call(
        'query_records',
        { userId: FIXTURE_ACTOR.id, proposer: { kind: 'ask', runId: null } },
        scoped,
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('Bad input for query_records')
  })
})
