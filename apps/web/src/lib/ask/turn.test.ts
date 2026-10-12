import { Effect } from 'effect'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { and, count, eq, inArray } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiRun,
  aiUsage,
  askTurn,
  company,
  entity,
  entitySpace,
  link,
  note,
  space,
  user,
  workspace,
} from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { setAiRouteProgram } from '#/lib/ai/route'
import { toolRegistry } from '#/lib/mcp/registry'
import { searchRecordsProgram } from '#/lib/mcp/tools-read'
import { askEvents, askStream } from './turn'
import {
  getThreadProgram,
  listThreadsProgram,
  saveAnswerNoteProgram,
} from './threads'
import type { AskEvent } from './types'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * An Ask turn end to end against the test database: tools through the
 * registry, the turn frozen as asked, the sensitivity gate per retrieval,
 * the cap, Stop, lost access, Save as note and privacy. (D70)
 */

const run = <TValue, TError>(e: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(e)

const TEAMMATE = {
  id: 'ask-teammate',
  name: 'Teammate',
  email: 'ask-teammate@spaces.test',
}

const usage = {
  inputTokens: {
    total: 30,
    noCache: 30,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
}

/**
 * A model that calls one tool, then answers: the first step of each attempt
 * emits the tool call, the step after a tool result emits `answer`.
 */
function agentModel(
  call: { toolName: string; input: unknown },
  answer: (prompt: string) => string,
) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async (options) => {
      const last = options.prompt.at(-1)
      const sawResult = last?.role === 'tool'
      if (sawResult) {
        const chunks = [
          { type: 'text-start' as const, id: 't' },
          {
            type: 'text-delta' as const,
            id: 't',
            delta: answer(JSON.stringify(options.prompt)),
          },
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

async function aCompany(name: string): Promise<string> {
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

async function collect(
  events: AsyncIterable<AskEvent>,
): Promise<Array<AskEvent>> {
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

const route = (
  sensitivity: 'normal' | 'sensitive',
  provider: 'anthropic' | 'ollama',
) =>
  run(
    setAiRouteProgram({
      lane: 'synthesize',
      sensitivity,
      provider,
      model: provider === 'ollama' ? 'llama3.2' : 'claude-opus-5',
    }),
  )

beforeAll(async () => {
  await db.insert(user).values(TEAMMATE)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await db.update(workspace).set({ settings: {} }).where(eq(workspace.id, 1))
})

/** The ai_run rows behind a thread's answers. */
const runsOf = async (threadId: string) => {
  const turns = await db
    .select({ runId: askTurn.aiRunId })
    .from(askTurn)
    .where(and(eq(askTurn.threadId, threadId), eq(askTurn.role, 'assistant')))
  const ids = turns.flatMap((t) => (t.runId === null ? [] : [t.runId]))
  return ids.length === 0
    ? []
    : db.select().from(aiRun).where(inArray(aiRun.id, ids))
}

describe('an Ask turn', () => {
  it('calls tools through the MCP registry, cites, and stores the turn frozen with one ai_run', async () => {
    await route('normal', 'anthropic')
    const acme = await aCompany('Acme Rockets')
    const spy = vi.spyOn(toolRegistry, 'call')
    const model = agentModel(
      { toolName: 'search_records', input: { query: 'Acme' } },
      () => `Acme Rockets is in the pipeline [record:${acme}].`,
    )
    const events = await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'Which rocket companies do we track?',
        scope: [],
        model,
      }),
    )
    expect(spy).toHaveBeenCalledWith(
      'search_records',
      expect.objectContaining({ userId: FIXTURE_ACTOR.id }),
      { query: 'Acme' },
    )
    expect(
      events.some((e) => e.type === 'call' && e.call.tool === 'search_records'),
    ).toBe(true)
    const turn = endOf(events)
    expect(turn.state).toBe('answered')
    expect(turn.route).toBe('Anthropic · claude-opus-5')
    expect(turn.refs).toEqual([
      {
        ref: `record:${acme}`,
        label: 'Acme Rockets',
        href: `/companies/${acme}`,
        entityId: acme,
      },
    ])
    expect(turn.calls).toEqual([
      { tool: 'search_records', state: 'done', input: '“Acme”', found: 1 },
    ])

    const runs = await runsOf(threadOf(events))
    expect(runs).toHaveLength(1)
    expect(runs.at(0)?.status).toBe('done')
    const usageRows = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.runId, runs.at(0)?.id ?? ''))
    expect(usageRows).toHaveLength(1)

    // Frozen: renaming the record later changes nothing the turn shows.
    await db
      .update(entity)
      .set({ canonicalName: 'Acme Aerospace' })
      .where(eq(entity.id, acme))
    const thread = await run(
      getThreadProgram(FIXTURE_ACTOR.id, threadOf(events)),
    )
    const answer = thread.turns.at(1)
    expect(answer?.body).toBe(
      `Acme Rockets is in the pipeline [record:${acme}].`,
    )
    expect(answer?.refs.at(0)?.label).toBe('Acme Rockets')
    expect(thread.turns.at(0)?.scope).toEqual([])
  })

  it('drops a citation to a record the turn never retrieved', async () => {
    await route('normal', 'anthropic')
    const acme = await aCompany('Acme Rockets')
    const unseen = await aCompany('Never Seen')
    const model = agentModel(
      { toolName: 'get_record', input: { id: acme } },
      () => `Acme is real [record:${acme}]. Never Seen too [record:${unseen}].`,
    )
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'q',
          scope: [],
          model,
        }),
      ),
    )
    expect(turn.refs.map((r) => r.ref)).toEqual([`record:${acme}`])
  })

  it('reads "empty" with what was searched when nothing is found', async () => {
    await route('normal', 'anthropic')
    const model = agentModel(
      { toolName: 'search_records', input: { query: 'zeppelins' } },
      () => 'I found nothing about zeppelins.',
    )
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'zeppelins?',
          scope: [],
          model,
        }),
      ),
    )
    expect(turn.state).toBe('empty')
    expect(turn.calls).toEqual([
      { tool: 'search_records', state: 'done', input: '“zeppelins”', found: 0 },
    ])
  })
})

describe('the gate', () => {
  let spaces = 0
  async function secretCompany() {
    const [spaceEnt] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: 'Fund II', sensitive: true })
      .returning({ id: entity.id })
    const slug = `fund_ii_${++spaces}`
    await db.insert(space).values({ entityId: spaceEnt.id, slug, path: slug })
    const secret = await aCompany('Quiet Co')
    await db.insert(entitySpace).values({
      entityId: secret,
      spaceId: spaceEnt.id,
      source: 'manual',
      createdBy: FIXTURE_ACTOR.id,
    })
    return secret
  }

  it('re-routes a turn whose retrieval touched a sensitive record to the local model, and says so', async () => {
    await route('normal', 'anthropic')
    await route('sensitive', 'ollama')
    const secret = await secretCompany()
    const model = agentModel(
      { toolName: 'get_record', input: { id: secret } },
      () => `Quiet Co is quiet [record:${secret}].`,
    )
    const events = await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'How is Quiet Co?',
        scope: [],
        model,
      }),
    )
    const routes = events.flatMap((e) => (e.type === 'route' ? [e] : []))
    expect(routes.map((r) => r.line)).toEqual([
      'Anthropic · claude-opus-5',
      'Sensitive (inherited from Fund II) · answered locally by Ollama · llama3.2',
    ])
    const turn = endOf(events)
    expect(turn.state).toBe('answered')
    expect(turn.route).toContain('answered locally by Ollama')
    expect(turn.refs.map((r) => r.ref)).toEqual([`record:${secret}`])
    expect(await runsOf(threadOf(events))).toHaveLength(1)
    // The cloud attempt asked once and never got the record back.
    expect(
      model.doStreamCalls.at(0)?.prompt.some((m) => m.role === 'tool'),
    ).toBe(false)
    expect(model.doStreamCalls).toHaveLength(3)
  })

  it('refuses when the sensitive scope has no local route, naming it', async () => {
    await route('normal', 'anthropic')
    await route('sensitive', 'anthropic')
    const secret = await secretCompany()
    const model = agentModel(
      { toolName: 'get_record', input: { id: secret } },
      () => 'never',
    )
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'How is Quiet Co?',
          scope: [
            {
              kind: 'record',
              id: secret,
              name: 'Quiet Co',
              href: `/companies/${secret}`,
            },
          ],
          model,
        }),
      ),
    )
    expect(turn.state).toBe('refused')
    expect(turn.route).toBe(
      'Refused · Sensitive material is not sent to Anthropic (sensitivity inherited from Fund II); route the synthesize lane to a local model',
    )
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('reads "no provider" when no model is routed', async () => {
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'anything',
          scope: [],
        }),
      ),
    )
    expect(turn.state).toBe('no_provider')
    expect(turn.route).toBe('Ask needs a model to answer')
  })

  it('refuses the turn at the daily cap, with one ai_run', async () => {
    await route('normal', 'anthropic')
    await db
      .insert(workspace)
      .values({
        id: 1,
        name: 'Fund',
        settings: { ai_caps: { daily_tokens: 20 } },
      })
      .onConflictDoUpdate({
        target: workspace.id,
        set: { settings: { ai_caps: { daily_tokens: 20 } } },
      })
    await db.insert(aiUsage).values({
      lane: 'classify',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      tokensIn: 15,
      tokensOut: 10,
      callerType: 'system',
      callerId: null,
    })
    const events = await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'anything',
        scope: [],
        model: agentModel({ toolName: 'list_registry', input: {} }, () => ''),
      }),
    )
    const turn = endOf(events)
    expect(turn.state).toBe('capped')
    expect(turn.route).toContain('cap')
    const runs = await runsOf(threadOf(events))
    expect(runs).toHaveLength(1)
    expect(runs.at(0)?.status).toBe('failed')
  })
  it('says the answer went local when a local route retrieved a sensitive record mid-turn', async () => {
    await route('normal', 'ollama')
    await route('sensitive', 'ollama')
    const secret = await secretCompany()
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'How is Quiet Co?',
          scope: [],
          model: agentModel(
            { toolName: 'get_record', input: { id: secret } },
            () => `Quiet Co is quiet [record:${secret}].`,
          ),
        }),
      ),
    )
    expect(turn.state).toBe('answered')
    expect(turn.route).toBe(
      'Sensitive (inherited from Fund II) · answered locally by Ollama · llama3.2',
    )
  })
})

describe('settling a turn', () => {
  it('keeps a tool call settled when the tool finished before the reader pulled its part', async () => {
    await route('normal', 'anthropic')
    const events = askEvents({
      userId: FIXTURE_ACTOR.id,
      threadId: null,
      question: 'zeppelins?',
      scope: [],
      model: agentModel(
        { toolName: 'search_records', input: { query: 'zeppelins' } },
        () => 'Nothing about zeppelins.',
      ),
    })
    const seen: Array<AskEvent> = []
    for (;;) {
      const next = await events.next()
      if (next.done) break
      seen.push(next.value)
      // A slow reader: the tool runs to completion before the next pull.
      if (next.value.type === 'route')
        await new Promise((resolve) => setTimeout(resolve, 150))
    }
    const turn = endOf(seen)
    expect(turn.calls).toEqual([
      { tool: 'search_records', state: 'done', input: '“zeppelins”', found: 0 },
    ])
    expect(turn.state).toBe('empty')
  })

  it('stores a provider failure as failed even when every retrieval found nothing', async () => {
    await route('normal', 'anthropic')
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async (options) => {
        if (options.prompt.at(-1)?.role === 'tool') {
          const chunks = [
            { type: 'error' as const, error: new Error('overloaded') },
          ]
          return { stream: simulateReadableStream({ chunks }) }
        }
        const chunks = [
          {
            type: 'tool-call' as const,
            toolCallId: 'c1',
            toolName: 'search_records',
            input: JSON.stringify({ query: 'zeppelins' }),
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
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'zeppelins?',
          scope: [],
          model,
        }),
      ),
    )
    expect(turn.state).toBe('failed')
    expect(turn.route).toBe('Anthropic did not answer')
  })
})

describe('Stop', () => {
  it('ends the stream and stores the turn as stopped with what had arrived', async () => {
    await route('normal', 'anthropic')
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 't' })
            controller.enqueue({
              type: 'text-delta',
              id: 't',
              delta: 'Partial answer',
            })
            abortSignal?.addEventListener('abort', () =>
              controller.error(new Error('aborted')),
            )
          },
        }),
      }),
    })
    const reader = askStream({
      userId: FIXTURE_ACTOR.id,
      threadId: null,
      question: 'long question',
      scope: [],
      model,
    }).getReader()
    let threadId = ''
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value.type === 'turn') threadId = next.value.threadId
      if (next.value.type === 'text') break
    }
    await reader.cancel()
    const thread = await run(getThreadProgram(FIXTURE_ACTOR.id, threadId))
    expect(thread.turns.at(1)?.state).toBe('stopped')
    expect(thread.turns.at(1)?.body).toBe('Partial answer')
  })
})

describe('the thread store', () => {
  it('hides an answer whose cited note became private to someone else, and not for its author', async () => {
    await route('normal', 'anthropic')
    const acme = await aCompany('Acme Rockets')
    const noteOf = async (authorId: string) => {
      const [ent] = await db
        .insert(entity)
        .values({ kind: 'note', canonicalName: 'Call' })
        .returning({ id: entity.id })
      await db.insert(note).values({
        entityId: ent.id,
        authorId,
        title: 'Call',
        bodyMd: 'Raising in Q4.',
      })
      await db.insert(link).values({
        fromEntityId: ent.id,
        toEntityId: acme,
        relation: 'tagged_in',
        source: 'manual',
        createdBy: authorId,
      })
      return ent.id
    }
    const theirs = await noteOf(TEAMMATE.id)
    const mine = await noteOf(FIXTURE_ACTOR.id)
    const ask = async (noteId: string) =>
      threadOf(
        await collect(
          askEvents({
            userId: FIXTURE_ACTOR.id,
            threadId: null,
            question: 'Acme?',
            scope: [],
            model: agentModel(
              { toolName: 'get_context', input: { entity: acme } },
              () => `Acme is raising in Q4 [note:${noteId}].`,
            ),
          }),
        ),
      )
    const t1 = await ask(theirs)
    const t2 = await ask(mine)
    await db
      .update(note)
      .set({ visibility: 'private' })
      .where(eq(note.entityId, theirs))
    await db
      .update(note)
      .set({ visibility: 'private' })
      .where(eq(note.entityId, mine))

    const hidden = await run(getThreadProgram(FIXTURE_ACTOR.id, t1))
    expect(hidden.turns.at(1)?.hidden).toBe(true)
    expect(hidden.turns.at(1)?.body).toBe('')
    expect(hidden.turns.at(0)?.body).toBe('Acme?')
    const kept = await run(getThreadProgram(FIXTURE_ACTOR.id, t2))
    expect(kept.turns.at(1)?.hidden).toBe(false)
  })

  it('lists threads only for their author and refuses another user the id', async () => {
    await route('normal', 'anthropic')
    const threadId = threadOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'Private musings about Zephyr',
          scope: [],
          model: agentModel(
            { toolName: 'list_registry', input: {} },
            () => 'Nothing.',
          ),
        }),
      ),
    )
    expect(
      (await run(listThreadsProgram(FIXTURE_ACTOR.id))).map((t) => t.id),
    ).toContain(threadId)
    expect(await run(listThreadsProgram(TEAMMATE.id))).toEqual([])
    await expect(
      run(getThreadProgram(TEAMMATE.id, threadId)),
    ).rejects.toMatchObject({ _tag: 'AskThreadNotFound' })
    await expect(
      collect(
        askEvents({
          userId: TEAMMATE.id,
          threadId,
          question: 'append?',
          scope: [],
        }),
      ),
    ).rejects.toBeDefined()

    // Not an entity: no row, no search hit, nothing to mention.
    expect(
      await db
        .select({ n: count() })
        .from(entity)
        .where(eq(entity.canonicalName, 'Private musings about Zephyr')),
    ).toEqual([{ n: 0 }])
    const hits = await run(
      searchRecordsProgram({ id: FIXTURE_ACTOR.id }, { query: 'Zephyr' }),
    )
    expect(hits).toEqual([])
  })

  it('saves an answer as one note by the user, filed on the cited records, refs kept', async () => {
    await route('normal', 'anthropic')
    const acme = await aCompany('Acme Rockets')
    const events = await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'Acme?',
        scope: [],
        model: agentModel(
          { toolName: 'get_record', input: { id: acme } },
          () =>
            `Acme Rockets builds launchers [record:${acme}].\n\nAn uncited aside.`,
        ),
      }),
    )
    const turn = endOf(events)
    const before = (await db.select({ n: count() }).from(note)).at(0)?.n ?? 0
    const { noteId } = await run(
      saveAnswerNoteProgram(FIXTURE_ACTOR.id, turn.id),
    )
    expect((await db.select({ n: count() }).from(note)).at(0)?.n).toBe(
      before + 1,
    )
    const saved = (
      await db.select().from(note).where(eq(note.entityId, noteId))
    ).at(0)
    expect(saved?.authorId).toBe(FIXTURE_ACTOR.id)
    expect(saved?.visibility).toBe('shared')
    expect(saved?.bodyMd).toContain(
      'Acme Rockets builds launchers (Acme Rockets)',
    )
    expect(saved?.bodyMd).not.toContain('uncited aside')
    expect(saved?.bodyMd).toContain(`[[Acme Rockets|entity:${acme}]]`)
    const filed = await db
      .select()
      .from(link)
      .where(and(eq(link.fromEntityId, noteId), eq(link.relation, 'tagged_in')))
    expect(filed.map((l) => l.toEntityId)).toEqual([acme])
    const rows = await run(listThreadsProgram(FIXTURE_ACTOR.id))
    expect(rows.find((r) => r.id === threadOf(events))?.saved).toBe(1)
  })
})
