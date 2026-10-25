import { Effect } from 'effect'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  attributeEvent,
  company,
  entity,
  entitySpace,
  space,
  suggestion,
  user,
  workspace,
} from '@spaces/db/schema'
import { task } from '@spaces/db/schema/tasks'
import { setValues } from '@spaces/core/writes/attributes/values'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { acceptProgram } from '#/lib/ai/propose'
import { setAiRouteProgram } from '#/lib/ai/route'
import { listInboxProgram } from '#/lib/inbox/queue'
import { toolRegistry } from '#/lib/mcp/registry'
import { applyCardProgram, skipCardProgram } from './card-store'
import { askEvents } from './turn'
import { getThreadProgram } from './threads'
import type { AskEvent } from './types'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Action cards end to end: a turn proposes them through `propose_card`, the
 * answer stores them as open suggestions, Apply writes through the writer a
 * person would as the reader, a conflict writes nothing, and an undecided
 * card waits in Review under its thread.
 */

const run = <TValue, TError>(e: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(e)

const usage = {
  inputTokens: {
    total: 30,
    noCache: 30,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
}

type Call = { toolName: string; input: unknown }

/** A model that runs one step of tool calls per entry, then answers. */
function scriptedModel(
  steps: ReadonlyArray<ReadonlyArray<Call>>,
  answer: string,
  /** Runs as the model starts its answer, after every tool call. */
  beforeAnswer?: () => Promise<void>,
) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async (options) => {
      const step = options.prompt.filter((m) => m.role === 'tool').length
      const calls = steps.at(step)
      if (calls === undefined) {
        await beforeAnswer?.()
        const chunks = [
          { type: 'text-start' as const, id: 't' },
          { type: 'text-delta' as const, id: 't', delta: answer },
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
        ...calls.map((c, i) => ({
          type: 'tool-call' as const,
          toolCallId: `call-${step}-${i}`,
          toolName: c.toolName,
          input: JSON.stringify(c.input),
        })),
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

async function mint(kind: 'company' | 'deal' | 'space', name: string) {
  const row = (
    await db
      .insert(entity)
      .values({ kind, canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no entity')
  if (kind === 'company') await db.insert(company).values({ entityId: row.id })
  return row.id
}

async function aSpace(name: string, slug: string) {
  const id = await mint('space', name)
  await db
    .insert(space)
    .values({ entityId: id, slug, path: slug, parentId: null })
  return id
}

async function aDeal(name: string, stage: string) {
  const id = await mint('deal', name)
  await setValues({
    entityId: id,
    patch: { stage },
    actor: { type: 'user', id: FIXTURE_ACTOR.id },
  })
  return id
}

async function collect(events: AsyncIterable<AskEvent>) {
  const out: Array<AskEvent> = []
  for await (const e of events) out.push(e)
  return out
}

const endOf = (events: ReadonlyArray<AskEvent>) => {
  const last = events.at(-1)
  if (last?.type !== 'end') throw new Error('the turn did not end')
  return last.turn
}

const threadOf = (events: ReadonlyArray<AskEvent>) => {
  const first = events.at(0)
  if (first?.type !== 'turn') throw new Error('no turn event')
  return first.threadId
}

const ask = (model: MockLanguageModelV4, question = 'What should I do?') =>
  collect(
    askEvents({
      userId: FIXTURE_ACTOR.id,
      threadId: null,
      question,
      scope: [],
      model,
    }),
  )

const stageEvents = (dealId: string) =>
  db
    .select()
    .from(attributeEvent)
    .where(
      and(
        eq(attributeEvent.entityId, dealId),
        eq(attributeEvent.attrSlug, 'stage'),
      ),
    )

afterEach(async () => {
  vi.restoreAllMocks()
  await db.update(workspace).set({ settings: {} }).where(eq(workspace.id, 1))
})

async function routed() {
  await run(
    setAiRouteProgram({
      lane: 'synthesize',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-opus-5',
    }),
  )
}

describe('Ask action cards', () => {
  it('proposes from the catalogue with evidence, stores each as an open suggestion, and applies through the writers as the reader', async () => {
    await routed()
    const acme = await mint('company', 'Acme Climate')
    const deal = await aDeal('Acme Seed', 'screening')
    const climate = await aSpace('Climate', 'climate')
    const model = scriptedModel(
      [
        [
          { toolName: 'get_record', input: { id: acme } },
          { toolName: 'get_record', input: { id: deal } },
        ],
        [
          {
            toolName: 'propose_card',
            input: {
              kind: 'task',
              record: acme,
              title: 'Call Acme',
              due: '2026-10-20',
              refs: [`record:${acme}`],
              rationale: 'Not spoken to in sixty days',
            },
          },
          {
            toolName: 'propose_card',
            input: {
              kind: 'move_stage',
              record: deal,
              stage: 'Diligence',
              refs: [`record:${deal}`],
              rationale: 'The meeting went well',
            },
          },
          {
            toolName: 'propose_card',
            input: {
              kind: 'file_into_space',
              record: acme,
              space: 'Climate',
              refs: [`record:${acme}`],
              rationale: 'A climate company',
            },
          },
          {
            toolName: 'propose_suggestion',
            input: {
              entity: acme,
              patch: {
                description: {
                  value: 'Carbon capture',
                  refs: [],
                  confidence: 0.8,
                },
              },
              rationale: 'From the record',
            },
          },
        ],
      ],
      `Acme has gone quiet [record:${acme}].`,
    )
    const events = await ask(model)
    expect(events.filter((e) => e.type === 'card')).toHaveLength(3)
    const turn = endOf(events)
    expect(turn.state).toBe('answered')
    expect(turn.cards.map((c) => [c.kind, c.outcome, c.summary])).toEqual([
      ['task', 'open', 'Call Acme · due 2026-10-20'],
      ['move_stage', 'open', 'Screening → Diligence'],
      ['file_into_space', 'open', 'Climate'],
    ])
    for (const c of turn.cards) expect(c.evidence.length).toBeGreaterThan(0)

    // The attribute patch went to Review through propose_suggestion: a
    // suggestion, never a card.
    const patch = (
      await db
        .select()
        .from(suggestion)
        .where(eq(suggestion.kind, 'attribute_patch'))
    ).filter((s) => s.entityId === acme)
    expect(patch).toHaveLength(1)
    expect(patch.at(0)?.status).toBe('open')
    expect(turn.cards.map((c) => c.id)).not.toContain(patch.at(0)?.id)

    const [taskCard, stageCard, spaceCard] = turn.cards
    const before = (await stageEvents(deal)).length

    const appliedTask = await run(
      applyCardProgram(FIXTURE_ACTOR.id, taskCard.id),
    )
    expect(appliedTask.outcome).toBe('applied')
    const tasks = await db
      .select()
      .from(task)
      .where(eq(task.content, 'Call Acme'))
    expect(tasks).toHaveLength(1)
    expect(tasks.at(0)?.createdBy).toBe(FIXTURE_ACTOR.id)

    const appliedStage = await run(
      applyCardProgram(FIXTURE_ACTOR.id, stageCard.id),
    )
    expect(appliedStage.outcome).toBe('applied')
    const events2 = await stageEvents(deal)
    expect(events2).toHaveLength(before + 1)
    const moved = events2.find((e) => e.suggestionId === stageCard.id)
    expect(moved?.actorId).toBe(FIXTURE_ACTOR.id)
    expect(moved?.source).toBe('suggestion')

    const appliedSpace = await run(
      applyCardProgram(FIXTURE_ACTOR.id, spaceCard.id),
    )
    expect(appliedSpace.outcome).toBe('applied')
    const filed = await db
      .select()
      .from(entitySpace)
      .where(
        and(eq(entitySpace.entityId, acme), eq(entitySpace.spaceId, climate)),
      )
    expect(filed).toHaveLength(1)
    expect(filed.at(0)?.source).toBe('ai')
    expect(filed.at(0)?.createdBy).toBe(FIXTURE_ACTOR.id)

    // Reopened, the thread reads each outcome back.
    const thread = await run(
      getThreadProgram(FIXTURE_ACTOR.id, threadOf(events)),
    )
    expect(thread.turns.at(1)?.cards.map((c) => c.outcome)).toEqual([
      'applied',
      'applied',
      'applied',
    ])
  })

  it('renders a conflicting apply as not applied and writes nothing; Skip writes nothing', async () => {
    await routed()
    const acme = await mint('company', 'Beta Grid')
    const deal = await aDeal('Beta Seed', 'screening')
    const grid = await aSpace('Grid', 'grid')
    const model = scriptedModel(
      [
        [
          { toolName: 'get_record', input: { id: acme } },
          { toolName: 'get_record', input: { id: deal } },
        ],
        [
          {
            toolName: 'propose_card',
            input: {
              kind: 'move_stage',
              record: deal,
              stage: 'meeting',
              refs: [`record:${deal}`],
              rationale: 'Booked',
            },
          },
          {
            toolName: 'propose_card',
            input: {
              kind: 'file_into_space',
              record: acme,
              space: grid,
              refs: [`record:${acme}`],
              rationale: 'Grid storage',
            },
          },
          {
            toolName: 'propose_card',
            input: {
              kind: 'task',
              record: acme,
              title: 'Send the memo',
              refs: [`record:${acme}`],
              rationale: 'Asked for it',
            },
          },
        ],
      ],
      `Beta booked a meeting [record:${deal}].`,
    )
    const turn = endOf(await ask(model))
    const [stageCard, spaceCard, taskCard] = turn.cards

    // Someone got there first.
    await setValues({
      entityId: deal,
      patch: { stage: 'meeting' },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    })
    await db.insert(entitySpace).values({
      entityId: acme,
      spaceId: grid,
      source: 'manual',
      createdBy: FIXTURE_ACTOR.id,
    })
    const before = (await stageEvents(deal)).length

    const stage = await run(applyCardProgram(FIXTURE_ACTOR.id, stageCard.id))
    expect(stage.outcome).toBe('conflict')
    expect(await stageEvents(deal)).toHaveLength(before)
    const file = await run(applyCardProgram(FIXTURE_ACTOR.id, spaceCard.id))
    expect(file.outcome).toBe('conflict')
    const filings = await db
      .select()
      .from(entitySpace)
      .where(and(eq(entitySpace.entityId, acme), eq(entitySpace.spaceId, grid)))
    expect(filings).toHaveLength(1)
    expect(filings.at(0)?.source).toBe('manual')

    const skipped = await run(skipCardProgram(FIXTURE_ACTOR.id, taskCard.id))
    expect(skipped.outcome).toBe('skipped')
    expect(
      await db.select().from(task).where(eq(task.content, 'Send the memo')),
    ).toEqual([])
  })

  it('leaves an undecided card in Review under its thread, applying from there with the same writer', async () => {
    await routed()
    const acme = await mint('company', 'Gamma Solar')
    const model = scriptedModel(
      [
        [{ toolName: 'get_record', input: { id: acme } }],
        [
          {
            toolName: 'propose_card',
            input: {
              kind: 'task',
              record: acme,
              title: 'Ask Gamma for the deck',
              refs: [`record:${acme}`],
              rationale: 'No deck on file',
            },
          },
        ],
      ],
      `Gamma has no deck [record:${acme}].`,
    )
    const events = await ask(model, 'Who needs a follow-up in Climate?')
    const card = endOf(events).cards.at(0)
    if (card === undefined) throw new Error('no card')

    const mine = await run(
      listInboxProgram({ record: null, viewer: FIXTURE_ACTOR.id }),
    )
    const group = mine.find((r) => r.kind === 'ask_cards')
    if (group?.kind !== 'ask_cards') throw new Error('no thread group')
    expect(group.id).toBe(threadOf(events))
    expect(group.title).toBe('Who needs a follow-up in Climate?')
    expect(group.cards.flatMap((c) => c.suggestions.map((s) => s.id))).toEqual([
      card.id,
    ])

    // A teammate sees the card, never the private thread's title.
    await db.insert(user).values({
      id: 'cards-teammate',
      name: 'Teammate',
      email: 'cards-teammate@spaces.test',
    })
    const theirs = await run(
      listInboxProgram({ record: null, viewer: 'cards-teammate' }),
    )
    expect(theirs.some((r) => r.kind === 'ask_cards')).toBe(false)
    expect(
      theirs.some(
        (r) =>
          r.kind === 'suggestion' &&
          r.suggestions.some((s) => s.id === card.id),
      ),
    ).toBe(true)

    // Review's Accept is the same accept.
    await run(acceptProgram(card.id, { type: 'user', id: FIXTURE_ACTOR.id }))
    const tasks = await db
      .select()
      .from(task)
      .where(eq(task.content, 'Ask Gamma for the deck'))
    expect(tasks.at(0)?.createdBy).toBe(FIXTURE_ACTOR.id)
    const thread = await run(
      getThreadProgram(FIXTURE_ACTOR.id, threadOf(events)),
    )
    expect(thread.turns.at(1)?.cards.at(0)?.outcome).toBe('applied')
  })

  it('refuses a card whose evidence the turn never retrieved, and stores nothing', async () => {
    await routed()
    const acme = await mint('company', 'Delta Wind')
    const unseen = await mint('company', 'Never Read')
    const model = scriptedModel(
      [
        [{ toolName: 'get_record', input: { id: acme } }],
        [
          {
            toolName: 'propose_card',
            input: {
              kind: 'task',
              record: acme,
              title: 'Unproven',
              refs: [`record:${unseen}`],
              rationale: 'No proof',
            },
          },
        ],
      ],
      `Delta is quiet [record:${acme}].`,
    )
    const events = await ask(model)
    expect(events.some((e) => e.type === 'card')).toBe(false)
    const turn = endOf(events)
    expect(turn.cards).toEqual([])
    expect(turn.calls.find((c) => c.tool === 'propose_card')?.state).toBe(
      'refused',
    )
    expect(
      await db.select().from(suggestion).where(eq(suggestion.entityId, acme)),
    ).toEqual([])
  })

  it('is Ask’s alone: an MCP token cannot propose a card', async () => {
    const acme = await mint('company', 'Echo Hydro')
    const exit = await Effect.runPromiseExit(
      toolRegistry.call(
        'propose_card',
        {
          userId: FIXTURE_ACTOR.id,
          proposer: { kind: 'token', tokenId: 'tok' },
        },
        {
          kind: 'task',
          record: acme,
          title: 'x',
          refs: [`record:${acme}`],
          rationale: 'y',
        },
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(toolRegistry.tools.map((t) => t.name)).not.toContain('propose_card')
    expect(toolRegistry.askTools.map((t) => t.name)).toContain('propose_card')
  })

  it('never applies a stage card once the deal moved or closed since: it reads conflict and writes nothing', async () => {
    await routed()
    const moved = await aDeal('Zeta Seed', 'screening')
    const closed = await aDeal('Eta Seed', 'screening')
    const reopen = await aDeal('Theta Seed', 'passed')
    const card = (deal: string, stage: string): Call => ({
      toolName: 'propose_card',
      input: {
        kind: 'move_stage',
        record: deal,
        stage,
        refs: [`record:${deal}`],
        rationale: 'Worth a look',
      },
    })
    const model = scriptedModel(
      [
        [
          { toolName: 'get_record', input: { id: moved } },
          { toolName: 'get_record', input: { id: closed } },
          { toolName: 'get_record', input: { id: reopen } },
        ],
        [
          card(moved, 'diligence'),
          card(closed, 'diligence'),
          card(reopen, 'screening'),
        ],
      ],
      `Three deals [record:${moved}].`,
    )
    const [movedCard, closedCard, reopenCard] = endOf(await ask(model)).cards
    const actor = { type: 'user' as const, id: FIXTURE_ACTOR.id }
    await setValues({ entityId: moved, patch: { stage: 'meeting' }, actor })
    await setValues({ entityId: closed, patch: { stage: 'invested' }, actor })

    for (const [deal, c, held] of [
      [moved, movedCard, 'meeting'],
      [closed, closedCard, 'invested'],
      [reopen, reopenCard, 'passed'],
    ] as const) {
      const before = (await stageEvents(deal)).length
      const view = await run(applyCardProgram(FIXTURE_ACTOR.id, c.id))
      expect(view.outcome).toBe('conflict')
      expect(view.moved).toBe(true)
      expect(await stageEvents(deal)).toHaveLength(before)
      const row = (
        await db.select().from(entity).where(eq(entity.id, deal))
      ).at(0)
      expect(row?.values.stage).toBe(held)
      // Closed, so Review cannot apply it either.
      const s = (
        await db.select().from(suggestion).where(eq(suggestion.id, c.id))
      ).at(0)
      expect(s?.status).toBe('accepted')
    }
  })

  it('takes no evidence from a proposal: a card on a record only proposed on is refused', async () => {
    await routed()
    const acme = await mint('company', 'Iota Air')
    const other = await mint('company', 'Kappa Sea')
    const model = scriptedModel(
      [
        [{ toolName: 'get_record', input: { id: other } }],
        [
          {
            toolName: 'propose_card',
            input: {
              kind: 'task',
              record: acme,
              title: 'First',
              refs: [`record:${other}`],
              rationale: 'Read Kappa',
            },
          },
        ],
        [
          {
            toolName: 'propose_card',
            input: {
              kind: 'task',
              record: acme,
              title: 'Second',
              refs: [`record:${acme}`],
              rationale: 'Nothing read about Iota',
            },
          },
        ],
      ],
      `Kappa is fine [record:${other}].`,
    )
    const turn = endOf(await ask(model))
    expect(turn.cards.map((c) => c.summary)).toEqual(['First'])
    expect(
      turn.calls.filter((c) => c.tool === 'propose_card').map((c) => c.state),
    ).toEqual(['done', 'refused'])
  })

  it('refuses a task card due on a day that does not exist', async () => {
    await routed()
    const acme = await mint('company', 'Lambda Rail')
    const model = scriptedModel(
      [
        [{ toolName: 'get_record', input: { id: acme } }],
        [
          {
            toolName: 'propose_card',
            input: {
              kind: 'task',
              record: acme,
              title: 'Impossible',
              due: '2026-02-30',
              refs: [`record:${acme}`],
              rationale: 'Never',
            },
          },
        ],
      ],
      `Lambda [record:${acme}].`,
    )
    const turn = endOf(await ask(model))
    expect(turn.cards).toEqual([])
    expect(turn.calls.find((c) => c.tool === 'propose_card')?.state).toBe(
      'refused',
    )
    expect(
      await db.select().from(suggestion).where(eq(suggestion.entityId, acme)),
    ).toEqual([])
  })

  it('marks a proposed card that could not be stored as refused, with the reason', async () => {
    await routed()
    const acme = await mint('company', 'Mu Steel')
    const model = scriptedModel(
      [
        [{ toolName: 'get_record', input: { id: acme } }],
        [
          {
            toolName: 'propose_card',
            input: {
              kind: 'task',
              record: acme,
              title: 'Gone before stored',
              refs: [`record:${acme}`],
              rationale: 'Shown, then lost',
            },
          },
        ],
      ],
      'Mu was removed.',
      async () => {
        await db.delete(company).where(eq(company.entityId, acme))
        await db.delete(entity).where(eq(entity.id, acme))
      },
    )
    const events = await ask(model)
    expect(events.some((e) => e.type === 'card')).toBe(true)
    const turn = endOf(events)
    expect(turn.cards).toEqual([])
    const call = turn.calls.find((c) => c.tool === 'propose_card')
    expect(call?.state).toBe('refused')
    expect(call?.reason).toEqual(expect.any(String))
    expect(call?.card).toBeUndefined()
  })
})
