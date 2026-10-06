import { Effect } from 'effect'
import { MockEmbeddingModelV4 } from 'ai/test'
import { createOpenAI } from '@ai-sdk/openai'
import { and, count, eq, isNotNull, lte } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { aiUsage, chunk, credential, workspace } from '@spaces/db/schema'
import type { WorkspaceSettings } from '@spaces/db/schema/workspace'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { storeCredential } from '@spaces/core/writes/vault'
import { embedMessage, embedProgram } from './embed'
import type { EmbedOptions } from './embed'
import { pinEmbeddingProgram, readEmbeddingPinProgram } from './embedding-pin'
import {
  NO_PIN_HEADLINE,
  PIN_DIMS,
  modelsFor,
  needsRepinNote,
  pinHeadline,
  pinLockedMessage,
} from './providers/embed/ids'
import {
  getEmbeddingSettingsProgram,
  saveEmbeddingKeyProgram,
  testEmbeddingProgram,
} from './providers/embed/settings'

/**
 * SPA-51. `embed()` through an injected `EmbeddingModel` — the pin, the
 * sensitivity refusal, the cap, the width assertion and the `ai_usage` row
 * are all real; nothing reaches a network. Where the real OpenAI adapter is
 * exercised, it is handed a stub `fetch` that answers in OpenAI's
 * `/v1/embeddings` wire format.
 */

const USER = { type: 'user', id: FIXTURE_ACTOR.id } as const

const opts = (over: Partial<EmbedOptions> = {}): EmbedOptions => ({
  caller: USER,
  sensitivity: 'normal',
  ...over,
})

/** A deterministic vector of `width` floats, the shape a provider answers. */
const vector = (width: number, seed = 1): number[] =>
  Array.from({ length: width }, (_, i) =>
    Number((Math.sin(i * seed + seed) / 10).toFixed(6)),
  )

/**
 * The recorded fixture: `/v1/embeddings` as OpenAI answers it for a model
 * that ignores the requested width and emits its native 1536 — what
 * `text-embedding-ada-002` does. One wrong-width answer is all the dimension
 * trap needs.
 */
const OPENAI_1536_RESPONSE = {
  object: 'list',
  data: [{ object: 'embedding', index: 0, embedding: vector(1536) }],
  model: 'text-embedding-ada-002',
  usage: { prompt_tokens: 2, total_tokens: 2 },
}

function mockEmbedding(width: number, tokens = 5) {
  return new MockEmbeddingModelV4({
    provider: 'mock',
    modelId: 'mock-embedding',
    maxEmbeddingsPerCall: 2048,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((_, i) => vector(width, i + 1)),
      usage: { tokens },
      warnings: [],
    }),
  })
}

async function setSettings(settings: WorkspaceSettings) {
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

/** Vectors in the one column that holds them — the dimension trap's target. */
async function storedVectors() {
  const [{ value }] = await db
    .select({ value: count() })
    .from(chunk)
    .where(isNotNull(chunk.embedding))
  return value
}

async function usageRows() {
  const [{ value }] = await db.select({ value: count() }).from(aiUsage)
  return value
}

const saveKey = (provider: 'openai' | 'google' | 'voyage', key: string) =>
  Effect.runPromise(
    saveEmbeddingKeyProgram(FIXTURE_ACTOR.id, { provider, key }),
  )

const pin = (provider: 'openai' | 'google' | 'voyage', model: string) =>
  Effect.runPromise(pinEmbeddingProgram({ provider, model }))

beforeEach(async () => {
  await setSettings({})
  await db.delete(aiUsage).where(lte(aiUsage.at, new Date()))
  await db.delete(credential).where(isNotNull(credential.id))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embed()', () => {
  it('fails EmbeddingNotPinned with no pin, before any model is called or row written', async () => {
    const model = mockEmbedding(PIN_DIMS)
    const failure = await Effect.runPromise(
      Effect.flip(embedProgram(['Orbital'], opts({ model }))),
    )
    expect(failure._tag).toBe('EmbeddingNotPinned')
    expect(model.doEmbedCalls).toHaveLength(0)
    expect(await usageRows()).toBe(0)
  })

  it('embeds at the pin: 768-wide vectors, the dimensions option sent, one ai_usage row on the embed lane', async () => {
    await saveKey('openai', 'sk-embed-test-0000')
    await pin('openai', 'text-embedding-3-small')
    const model = mockEmbedding(PIN_DIMS, 7)

    const result = await Effect.runPromise(
      embedProgram(['Orbital', 'Composites'], opts({ model })),
    )
    expect(result.vectors).toHaveLength(2)
    expect(result.vectors.every((v) => v.length === 768)).toBe(true)
    expect(result.target).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dims: 768,
    })
    expect(model.doEmbedCalls[0].providerOptions).toEqual({
      openai: { dimensions: 768 },
    })

    const rows = await db.select().from(aiUsage)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      lane: 'embed',
      provider: 'openai',
      model: 'text-embedding-3-small',
      tokensIn: 7,
      tokensOut: null,
      callerType: 'user',
      callerId: FIXTURE_ACTOR.id,
    })
  })

  it('fails DimensionMismatch on a 1536-wide answer: no vector, one usage row for the billed tokens (mock model)', async () => {
    await saveKey('openai', 'sk-embed-test-0000')
    await pin('openai', 'text-embedding-3-small')
    const model = mockEmbedding(1536, 9)

    // Zero vectors: the call fails, so nothing reaches a caller to be stored.
    const failure = await Effect.runPromise(
      Effect.flip(embedProgram(['Orbital'], opts({ model }))),
    )
    expect(failure).toMatchObject({
      _tag: 'DimensionMismatch',
      expected: 768,
      received: 1536,
    })
    expect(embedMessage(failure)).toBe(
      'OpenAI text-embedding-3-small returned 1536 dimensions; this workspace stores 768',
    )
    // The provider billed the call, so the cap counts it.
    const rows = await db.select().from(aiUsage)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ lane: 'embed', tokensIn: 9 })
    expect(await storedVectors()).toBe(0)
  })

  it('fails DimensionMismatch against the recorded OpenAI wire fixture, through the real adapter', async () => {
    await saveKey('openai', 'sk-embed-test-0000')
    await pin('openai', 'text-embedding-3-small')
    const sent: unknown[] = []
    const model = createOpenAI({
      apiKey: 'sk-embed-test-0000',
      baseURL: 'https://api.openai.com/v1',
      fetch: async (_url, init) => {
        sent.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null)
        return new Response(JSON.stringify(OPENAI_1536_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    }).embedding('text-embedding-3-small')

    const failure = await Effect.runPromise(
      Effect.flip(embedProgram(['Orbital'], opts({ model, maxRetries: 0 }))),
    )
    expect(failure._tag).toBe('DimensionMismatch')
    expect(await storedVectors()).toBe(0)
    const rows = await db.select().from(aiUsage)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      lane: 'embed',
      provider: 'openai',
      model: 'text-embedding-3-small',
      tokensIn: 2,
      tokensOut: null,
    })
    expect(sent).toEqual([
      {
        model: 'text-embedding-3-small',
        input: ['Orbital'],
        encoding_format: 'float',
        dimensions: 768,
      },
    ])
  })

  it('refuses a sensitive call to the cloud embedder before any call', async () => {
    await saveKey('openai', 'sk-embed-test-0000')
    await pin('openai', 'text-embedding-3-small')
    const model = mockEmbedding(PIN_DIMS)

    const failure = await Effect.runPromise(
      Effect.flip(
        embedProgram(
          ['Orbital'],
          opts({
            model,
            sensitivity: 'sensitive',
            via: { kind: 'space', name: 'Fund II' },
          }),
        ),
      ),
    )
    expect(failure).toMatchObject({
      _tag: 'SensitiveRouteRefused',
      lane: 'embed',
      provider: 'openai',
    })
    expect(model.doEmbedCalls).toHaveLength(0)
    expect(await usageRows()).toBe(0)
  })

  it('checks the AI cap before the call', async () => {
    await saveKey('openai', 'sk-embed-test-0000')
    await pin('openai', 'text-embedding-3-small')
    const settings = (
      await db.select({ s: workspace.settings }).from(workspace)
    ).at(0)?.s
    await setSettings({ ...settings, ai_caps: { per_run_tokens: 1 } })
    const model = mockEmbedding(PIN_DIMS)

    const failure = await Effect.runPromise(
      Effect.flip(
        embedProgram(['a long passage of deck text'], opts({ model })),
      ),
    )
    expect(failure._tag).toBe('CapExceeded')
    expect(model.doEmbedCalls).toHaveLength(0)
  })
})

describe('the embedding pin', () => {
  it('reads no pin, and the section head says search matches words', async () => {
    expect(await Effect.runPromise(readEmbeddingPinProgram())).toBeNull()
    expect(NO_PIN_HEADLINE).toBe(
      'No embedding model — search matches words, not meaning.',
    )
  })

  it('pins OpenAI text-embedding-3-small at 768', async () => {
    await saveKey('openai', 'sk-embed-test-0000')
    const pinned = await pin('openai', 'text-embedding-3-small')
    expect(pinned).toMatchObject({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dims: 768,
    })
    const stored = (
      await db.select({ s: workspace.settings }).from(workspace)
    ).at(0)?.s
    expect(stored?.embedding).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dims: 768,
      pinned_at: pinned.pinnedAt,
    })
    expect(pinHeadline(pinned)).toBe(
      `Pinned to OpenAI text-embedding-3-small at 768 dimensions since ${pinned.pinnedAt.slice(0, 10)}.`,
    )
  })

  it('greys a model that only emits 1536 and refuses to pin it', async () => {
    const ada = modelsFor('openai').find(
      (m) => m.id === 'text-embedding-ada-002',
    )
    expect(ada?.emitsPin).toBe(false)
    if (!ada) throw new Error('ada-002 is not in the catalogue')
    expect(needsRepinNote(ada)).toBe(
      'needs re-pin — emits 1536, this workspace stores 768',
    )

    await saveKey('openai', 'sk-embed-test-0000')
    const failure = await Effect.runPromise(
      Effect.flip(
        pinEmbeddingProgram({
          provider: 'openai',
          model: 'text-embedding-ada-002',
        }),
      ),
    )
    expect(failure._tag).toBe('PinRefused')
    expect(failure.message).toContain('needs re-pin')
    expect(await Effect.runPromise(readEmbeddingPinProgram())).toBeNull()
  })

  it('greys every Voyage model: 768 is not an output dimension Voyage offers', () => {
    expect(modelsFor('voyage').every((m) => !m.emitsPin)).toBe(true)
  })

  it('refuses to pin before the provider has an embedding key', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        pinEmbeddingProgram({
          provider: 'google',
          model: 'text-embedding-004',
        }),
      ),
    )
    expect(failure).toMatchObject({
      _tag: 'PinRefused',
      message: 'Save a Google embedding key before pinning',
    })
  })

  it('refuses to change the pin to another width with the re-pin explanation, and leaves it as it was', async () => {
    // A same-width swap is allowed since SPA-136 (`worker/jobs/embed-backfill.test.ts`);
    // a change of width is still the unbuilt half of re-pin.
    await saveKey('openai', 'sk-embed-test-0000')
    const first = await pin('openai', 'text-embedding-3-small')

    const failure = await Effect.runPromise(
      Effect.flip(
        pinEmbeddingProgram({
          provider: 'openai',
          model: 'text-embedding-ada-002',
        }),
      ),
    )
    expect(failure._tag).toBe('PinLocked')
    expect(failure.message).toBe(
      'Embeddings are pinned to OpenAI text-embedding-3-small at 768 dimensions. text-embedding-ada-002 emits 1536; changing the width means altering the vector column and rebuilding its index, which this version cannot do yet.',
    )
    const ada = modelsFor('openai').find(
      (m) => m.id === 'text-embedding-ada-002',
    )
    if (!ada) throw new Error('ada-002 is not in the catalogue')
    expect(failure.message).toBe(pinLockedMessage(first, ada))
    expect(await Effect.runPromise(readEmbeddingPinProgram())).toEqual(first)

    // Pinning the pinned model again is a no-op, not a new pin.
    expect(await pin('openai', 'text-embedding-3-small')).toEqual(first)
    expect(await Effect.runPromise(readEmbeddingPinProgram())).toEqual(first)
  })
})

describe('the embedding key', () => {
  it("is stored with kind 'embedding' under its own row, leaving the OpenAI LLM key alone", async () => {
    await storeCredential({
      scope: 'workspace',
      provider: 'openai',
      kind: 'llm',
      secret: 'sk-llm-test-0000',
      meta: {},
      createdBy: FIXTURE_ACTOR.id,
    })
    const saved = await saveKey('openai', 'sk-embed-test-1234')
    expect(saved.display).not.toContain('embed-test')

    const rows = await db
      .select({ provider: credential.provider, kind: credential.kind })
      .from(credential)
      .where(eq(credential.scope, 'workspace'))
    expect(rows).toEqual(
      expect.arrayContaining([
        { provider: 'openai', kind: 'llm' },
        { provider: 'embed:openai', kind: 'embedding' },
      ]),
    )

    const view = await Effect.runPromise(getEmbeddingSettingsProgram())
    expect(view.keys.find((k) => k.provider === 'openai')).toMatchObject({
      configured: true,
      display: saved.display,
    })
    expect(view.keys.find((k) => k.provider === 'google')?.configured).toBe(
      false,
    )
  })
})

describe('the Test call', () => {
  it('embeds "Spaces" through the saved key and answers the width, four values and the model id', async () => {
    await saveKey('openai', 'sk-embed-test-5678')
    const sent: Array<{ auth: string | null; body: unknown }> = []
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      sent.push({
        auth: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: vector(768) }],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const result = await Effect.runPromise(
      testEmbeddingProgram(FIXTURE_ACTOR.id, {
        provider: 'openai',
        model: 'text-embedding-3-small',
      }),
    )
    expect(result).toEqual({
      ok: true,
      model: 'text-embedding-3-small',
      width: 768,
      head: vector(768).slice(0, 4),
    })
    expect(sent).toEqual([
      {
        auth: 'Bearer sk-embed-test-5678',
        body: {
          model: 'text-embedding-3-small',
          input: ['Spaces'],
          encoding_format: 'float',
          dimensions: 768,
        },
      },
    ])
    const rows = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.lane, 'embed'), eq(aiUsage.provider, 'openai')))
    expect(rows).toHaveLength(1)
    // The Test call tests a model; it pins nothing.
    expect(await Effect.runPromise(readEmbeddingPinProgram())).toBeNull()
  })

  it('refuses a greyed model without calling anything', async () => {
    await saveKey('openai', 'sk-embed-test-5678')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const result = await Effect.runPromise(
      testEmbeddingProgram(FIXTURE_ACTOR.id, {
        provider: 'openai',
        model: 'text-embedding-ada-002',
      }),
    )
    expect(result).toEqual({
      ok: false,
      status: null,
      message: 'needs re-pin — emits 1536, this workspace stores 768',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
