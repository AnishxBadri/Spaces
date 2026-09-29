import { Effect } from 'effect'
import { eq, isNotNull } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { aiRoute, credential } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { storeCredential } from '@spaces/core/writes/vault'
import { aiRouteInput } from './lanes'
import {
  aiRouteProgram,
  clearAiRouteProgram,
  isLaneRoutedProgram,
  listAiRoutesProgram,
  setAiRouteProgram,
} from './route'

/**
 * SPA-69. The Routing ledger's server half: a cell set and cleared reads back
 * through `aiRoute` with no restart, and `isLaneRouted` — the gate every AI
 * trigger hides on — is false with nothing configured, false once the routed
 * provider's credential is gone, and never fails. The file's tables start
 * truncated (the harness); each test here starts from no routes and no keys.
 */

const run = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(effect)

const anthropicKey = () =>
  storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: 'sk-ant-test-route-0000',
    meta: {},
    createdBy: FIXTURE_ACTOR.id,
  })

const ollamaSaved = () =>
  storeCredential({
    scope: 'workspace',
    provider: 'ollama',
    kind: 'llm',
    secret: '',
    keyless: true,
    meta: {},
    createdBy: FIXTURE_ACTOR.id,
  })

beforeEach(async () => {
  // Every row, on purpose: each test starts from no routes and no keys.
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(credential).where(isNotNull(credential.id))
})

describe('setAiRoute / clearAiRoute', () => {
  it('a set cell reads back through aiRoute, and a cleared one is unrouted', async () => {
    await run(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    expect(await run(aiRouteProgram('extract', 'normal'))).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
    })

    // A second write to the same cell replaces it — no restart, no cache.
    await run(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'normal',
        provider: 'openai',
        model: 'gpt-5.5',
      }),
    )
    expect(await run(aiRouteProgram('extract', 'normal'))).toEqual({
      provider: 'openai',
      model: 'gpt-5.5',
    })

    await run(clearAiRouteProgram('extract', 'normal'))
    const cleared = await Effect.runPromise(
      Effect.flip(aiRouteProgram('extract', 'normal')),
    )
    expect(cleared._tag).toBe('LaneNotRouted')
    expect(await db.select().from(aiRoute)).toEqual([])
  })

  it('clearing one cell leaves the other sensitivity alone', async () => {
    await run(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    await run(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'sensitive',
        provider: 'ollama',
        model: 'llama3.2',
      }),
    )
    await run(clearAiRouteProgram('extract', 'normal'))
    expect(await run(listAiRoutesProgram())).toEqual([
      {
        lane: 'extract',
        sensitivity: 'sensitive',
        target: { provider: 'ollama', model: 'llama3.2' },
      },
    ])
  })

  it('the input accepts a null provider as a clear, and refuses a set without a model', () => {
    expect(
      aiRouteInput.safeParse({
        lane: 'extract',
        sensitivity: 'normal',
        provider: null,
      }).success,
    ).toBe(true)
    expect(
      aiRouteInput.safeParse({
        lane: 'extract',
        sensitivity: 'normal',
        provider: 'anthropic',
      }).success,
    ).toBe(false)
  })
})

describe('isLaneRouted', () => {
  it('is false at both sensitivities with no routes and no keys', async () => {
    expect(await run(isLaneRoutedProgram('extract', FIXTURE_ACTOR.id))).toEqual(
      { normal: false, sensitive: false },
    )
  })

  it('is false for a route whose provider has no credential', async () => {
    await run(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    expect(await run(isLaneRoutedProgram('extract', null))).toEqual({
      normal: false,
      sensitive: false,
    })
  })

  it('is true once the routed provider has an active key, and false again when the key is deleted', async () => {
    await run(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    const { id } = await anthropicKey()
    expect(await run(isLaneRoutedProgram('extract', null))).toEqual({
      normal: true,
      sensitive: false,
    })

    await db.delete(credential).where(eq(credential.id, id))
    expect(await run(isLaneRoutedProgram('extract', null))).toEqual({
      normal: false,
      sensitive: false,
    })
  })

  it('reads an invalid credential as absent', async () => {
    await run(
      setAiRouteProgram({
        lane: 'classify',
        sensitivity: 'normal',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    const { id } = await anthropicKey()
    await db
      .update(credential)
      .set({ status: 'invalid' })
      .where(eq(credential.id, id))
    expect(await run(isLaneRoutedProgram('classify', null))).toEqual({
      normal: false,
      sensitive: false,
    })
  })

  it('is true for sensitive only when the route is local', async () => {
    await anthropicKey()
    await ollamaSaved()
    await run(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'sensitive',
        provider: 'anthropic',
        model: 'claude-opus-5',
      }),
    )
    // `complete()` would refuse this call, so the trigger is hidden.
    expect(await run(isLaneRoutedProgram('extract', null))).toEqual({
      normal: false,
      sensitive: false,
    })

    await run(
      setAiRouteProgram({
        lane: 'extract',
        sensitivity: 'sensitive',
        provider: 'ollama',
        model: 'llama3.2',
      }),
    )
    expect(await run(isLaneRoutedProgram('extract', null))).toEqual({
      normal: false,
      sensitive: true,
    })
  })

  it("counts the caller's own key, and only the caller's", async () => {
    await run(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'normal',
        provider: 'openai',
        model: 'gpt-5.5',
      }),
    )
    await storeCredential({
      scope: 'user',
      userId: FIXTURE_ACTOR.id,
      provider: 'openai',
      kind: 'llm',
      secret: 'sk-user-test-0000',
      meta: {},
      createdBy: FIXTURE_ACTOR.id,
    })
    expect(
      (await run(isLaneRoutedProgram('synthesize', FIXTURE_ACTOR.id))).normal,
    ).toBe(true)
    expect((await run(isLaneRoutedProgram('synthesize', null))).normal).toBe(
      false,
    )
  })

  it('reads a route naming an unknown provider as unrouted rather than failing', async () => {
    await db.insert(aiRoute).values({
      lane: 'vision',
      sensitivity: 'normal',
      provider: 'not-a-provider',
      model: 'x',
    })
    expect(await run(isLaneRoutedProgram('vision', null))).toEqual({
      normal: false,
      sensitive: false,
    })
    expect(await run(listAiRoutesProgram())).toEqual([])
  })
})
