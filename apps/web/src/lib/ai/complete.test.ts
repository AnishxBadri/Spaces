import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { count, desc, ne } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { aiRoute, aiUsage } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { storeCredential } from '#/lib/vault'
import type { ContextItem } from '#/lib/context/types'
import { completeMessage, completeProgram } from './complete'
import type { CompleteOptions } from './complete'
import { setAiRouteProgram } from './route'
import { runTestCall } from './providers/test-call'
import { testAiProviderProgram } from './providers/settings'

/**
 * SPA-42. `complete()` through an injected model — `MockLanguageModelV4`
 * from `ai/test` — which is the pattern every later AI test follows: the
 * route, the sensitivity refusal, the prompt and the `ai_usage` row are all
 * real, and nothing reaches a network. The one test that exercises the real
 * Anthropic adapter (the Providers Test call, end to end) hands it a stub
 * `fetch`, as `providers/anthropic.test.ts` does.
 */

const ITEMS: ContextItem[] = [
  {
    ref: 'attr:e1:stage',
    kind: 'attribute',
    text: 'Stage: Seed',
    entityIds: ['e1'],
    at: null,
  },
  {
    ref: 'note:n1',
    kind: 'note',
    text: 'Raising a Series A in Q4.',
    entityIds: ['e1'],
    at: '2026-09-01',
  },
]

const USER = { type: 'user', id: FIXTURE_ACTOR.id } as const

const opts = (over: Partial<CompleteOptions> = {}): CompleteOptions => ({
  caller: USER,
  sensitivity: 'normal',
  budgetChars: 4000,
  task: 'Which stage is this company at?',
  ...over,
})

/** A model that answers `text` with the given token counts, recording calls. */
function mockModel(text = 'Series A', tokensIn = 12, tokensOut = 3) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: tokensIn,
          noCache: tokensIn,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: tokensOut,
          text: tokensOut,
          reasoning: undefined,
        },
      },
      warnings: [],
    }),
  })
}

async function usageRows() {
  const [{ value }] = await db.select({ value: count() }).from(aiUsage)
  return value
}

const lastUsage = async () =>
  (await db.select().from(aiUsage).orderBy(desc(aiUsage.at)).limit(1)).at(0)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('complete()', () => {
  it('fails LaneNotRouted with no route configured, before any model is called', async () => {
    const model = mockModel()
    const failure = await Effect.runPromise(
      Effect.flip(
        completeProgram('classify', ITEMS, undefined, opts({ model })),
      ),
    )
    expect(failure._tag).toBe('LaneNotRouted')
    expect(completeMessage(failure)).toBe(
      'No model is routed for the classify lane',
    )
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await usageRows()).toBe(0)
  })

  it('refuses a sensitive call routed to a cloud provider, and runs it routed to Ollama', async () => {
    await Effect.runPromise(
      setAiRouteProgram({
        lane: 'classify',
        sensitivity: 'sensitive',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    )
    const cloud = mockModel()
    const refused = await Effect.runPromise(
      Effect.flip(
        completeProgram(
          'classify',
          ITEMS,
          undefined,
          opts({ sensitivity: 'sensitive', model: cloud }),
        ),
      ),
    )
    expect(refused._tag).toBe('SensitiveRouteRefused')
    expect(cloud.doGenerateCalls).toHaveLength(0)
    expect(await usageRows()).toBe(0)

    // The same cell, re-pointed at the local provider: the same call runs.
    await Effect.runPromise(
      setAiRouteProgram({
        lane: 'classify',
        sensitivity: 'sensitive',
        provider: 'ollama',
        model: 'llama3.2',
      }),
    )
    expect(await db.select().from(aiRoute)).toHaveLength(1)
    const local = mockModel()
    const result = await Effect.runPromise(
      completeProgram(
        'classify',
        ITEMS,
        undefined,
        opts({ sensitivity: 'sensitive', model: local }),
      ),
    )
    expect(result.output).toEqual({ kind: 'text', text: 'Series A' })
    expect(result.target).toEqual({ provider: 'ollama', model: 'llama3.2' })
    expect(local.doGenerateCalls).toHaveLength(1)
    expect(await lastUsage()).toMatchObject({
      lane: 'classify',
      provider: 'ollama',
      model: 'llama3.2',
    })
  })

  it('renders the items as [ref] text, and writes one ai_usage row with both token counts and the caller', async () => {
    await Effect.runPromise(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    const model = mockModel('A seed-stage company raising its A.', 40, 9)
    const before = await usageRows()

    await Effect.runPromise(
      completeProgram('synthesize', ITEMS, undefined, opts({ model })),
    )

    const [call] = model.doGenerateCalls
    expect(JSON.stringify(call.prompt)).toContain(
      '[attr:e1:stage] Stage: Seed\\n\\n[note:n1] Raising a Series A in Q4.',
    )
    expect(await usageRows()).toBe(before + 1)
    expect(await lastUsage()).toMatchObject({
      lane: 'synthesize',
      provider: 'anthropic',
      model: 'claude-opus-5',
      tokensIn: 40,
      tokensOut: 9,
      callerType: 'user',
      callerId: FIXTURE_ACTOR.id,
      jobRunId: null,
    })
  })

  it('returns an object when handed an output schema', async () => {
    await Effect.runPromise(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    )
    const model = mockModel(
      '{"stage":{"value":"seed","refs":["attr:e1:stage"]}}',
    )
    const result = await Effect.runPromise(
      completeProgram(
        'extract',
        ITEMS,
        {
          type: 'object',
          properties: {
            stage: {
              type: 'object',
              properties: {
                value: { type: 'string' },
                refs: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        opts({ model }),
      ),
    )
    expect(result.output).toEqual({
      kind: 'object',
      object: { stage: { value: 'seed', refs: ['attr:e1:stage'] } },
    })
  })

  it('wraps a provider failure as ProviderCallFailed and records no usage', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      },
    })
    const before = await usageRows()
    const failure = await Effect.runPromise(
      Effect.flip(
        completeProgram(
          'extract',
          ITEMS,
          undefined,
          opts({
            model,
            maxRetries: 0,
            route: { provider: 'anthropic', model: 'claude-haiku-4-5' },
          }),
        ),
      ),
    )
    expect(failure._tag).toBe('ProviderCallFailed')
    expect(completeMessage(failure)).toBe('Anthropic did not answer')
    expect(await usageRows()).toBe(before)
  })
})

describe('the Providers Test call through complete()', () => {
  it('runs the injected model and writes one ai_usage row for the user who pressed it', async () => {
    const model = mockModel('OK', 9, 1)
    const before = await usageRows()
    const result = await Effect.runPromise(
      runTestCall(model, {
        provider: 'anthropic',
        lane: 'classify',
        caller: USER,
      }),
    )
    expect(result).toEqual({ ok: true, text: 'OK' })
    expect(await usageRows()).toBe(before + 1)
    expect(await lastUsage()).toMatchObject({
      provider: 'anthropic',
      model: 'mock-model',
      tokensIn: 9,
      tokensOut: 1,
      callerType: 'user',
      callerId: FIXTURE_ACTOR.id,
    })
  })

  it('the demo: classify routed to Anthropic, Test pressed, one row with the routed model and real counts', async () => {
    // The demo's grid: classify → Anthropic and nothing else. The earlier
    // tests in this file routed other lanes to Anthropic, and the Test call
    // records under the first lane routed to its provider.
    await db.delete(aiRoute).where(ne(aiRoute.lane, 'classify'))
    await Effect.runPromise(
      setAiRouteProgram({
        lane: 'classify',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    )
    await storeCredential({
      scope: 'workspace',
      provider: 'anthropic',
      kind: 'llm',
      secret: 'sk-ant-test-demo-0000',
      meta: {},
      createdBy: FIXTURE_ACTOR.id,
    })
    const sent: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      sent.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null)
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 14, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const before = await usageRows()

    const result = await Effect.runPromise(
      testAiProviderProgram('anthropic', FIXTURE_ACTOR.id),
    )

    expect(result).toEqual({ ok: true, text: 'OK' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ model: 'claude-haiku-4-5' })
    expect(await usageRows()).toBe(before + 1)
    expect(await lastUsage()).toMatchObject({
      lane: 'classify',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      tokensIn: 14,
      tokensOut: 2,
      callerType: 'user',
      callerId: FIXTURE_ACTOR.id,
    })
  })

  it("keeps the provider's own words on a refusal, and records no usage", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('invalid x-api-key')
      },
    })
    const before = await usageRows()
    const result = await Effect.runPromise(
      runTestCall(model, {
        provider: 'anthropic',
        lane: 'classify',
        caller: USER,
      }),
    )
    expect(result).toEqual({
      ok: false,
      status: null,
      message: 'invalid x-api-key',
    })
    expect(await usageRows()).toBe(before)
  })
})
