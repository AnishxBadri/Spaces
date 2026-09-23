import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { providerFailure } from '../test-call'
import { embedCallFor } from './index'
import { EMBEDDING_MODELS, EMBEDDING_PROVIDERS, PIN_DIMS } from './ids'

/**
 * SPA-51. The three embedding adapters, each asserted against the request it
 * builds: a stub transport records the one request and answers in that
 * provider's wire format, so the URL, the key, the model and the requested
 * width are read off the wire with no network and no database row.
 */

type Recorded = { url: string; headers: Headers; body: unknown }

function recordingFetch(reply: () => Response) {
  const calls: Recorded[] = []
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url, headers: new Headers(init?.headers), body })
    return reply()
  }
  return { fetch, calls }
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

const floats = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => (i + seed) / 1000)

describe('the catalogue', () => {
  it('lists every provider, and a model is pinnable only if it can emit 768', () => {
    for (const provider of EMBEDDING_PROVIDERS)
      expect(EMBEDDING_MODELS.some((m) => m.provider === provider)).toBe(true)
    const pinnable = EMBEDDING_MODELS.filter((m) => m.emitsPin).map(
      (m) => `${m.provider}/${m.id}`,
    )
    expect(pinnable).toEqual([
      'openai/text-embedding-3-small',
      'openai/text-embedding-3-large',
      'google/text-embedding-004',
      'google/gemini-embedding-001',
    ])
    expect(PIN_DIMS).toBe(768)
  })
})

describe('Google', () => {
  it('asks for outputDimensionality 768 through the key header, never the URL', async () => {
    const { fetch, calls } = recordingFetch(
      json({ embedding: { values: floats(768, 1) } }),
    )
    const call = embedCallFor(
      'google',
      { secret: 'AIza-test', meta: {} },
      'gemini-embedding-001',
      768,
      fetch,
    )
    const answer = await Effect.runPromise(call(['Spaces']))
    expect(answer).toEqual({ embeddings: [floats(768, 1)], tokens: null })
    expect(calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
    )
    expect(calls[0].url).not.toContain('AIza-test')
    expect(calls[0].headers.get('x-goog-api-key')).toBe('AIza-test')
    expect(calls[0].body).toMatchObject({
      model: 'models/gemini-embedding-001',
      outputDimensionality: 768,
    })
  })
})

describe('OpenAI', () => {
  it('asks for dimensions 768 at the base URL the credential names, with its headers', async () => {
    const { fetch, calls } = recordingFetch(
      json({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: floats(768, 2) }],
        model: 'text-embedding-3-large',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    )
    const call = embedCallFor(
      'openai',
      {
        secret: 'sk-test',
        meta: {
          baseUrl: 'https://gateway.example/v1',
          headers: { 'Helicone-Auth': 'Bearer h' },
        },
      },
      'text-embedding-3-large',
      768,
      fetch,
    )
    const answer = await Effect.runPromise(call(['Spaces']))
    expect(answer).toEqual({ embeddings: [floats(768, 2)], tokens: 3 })
    expect(calls[0].url).toBe('https://gateway.example/v1/embeddings')
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-test')
    expect(calls[0].headers.get('helicone-auth')).toBe('Bearer h')
    expect(calls[0].body).toMatchObject({ dimensions: 768 })
  })
})

describe('Voyage', () => {
  it('posts to /v1/embeddings with the output dimension, and returns vectors in input order', async () => {
    const { fetch, calls } = recordingFetch(
      json({
        object: 'list',
        data: [
          { object: 'embedding', index: 1, embedding: floats(4, 20) },
          { object: 'embedding', index: 0, embedding: floats(4, 10) },
        ],
        model: 'voyage-3.5',
        usage: { total_tokens: 6 },
      }),
    )
    const call = embedCallFor(
      'voyage',
      { secret: 'pa-test', meta: {} },
      'voyage-3.5',
      1024,
      fetch,
    )
    const answer = await Effect.runPromise(call(['first', 'second']))
    expect(answer).toEqual({
      embeddings: [floats(4, 10), floats(4, 20)],
      tokens: 6,
    })
    expect(calls[0].url).toBe('https://api.voyageai.com/v1/embeddings')
    expect(calls[0].headers.get('authorization')).toBe('Bearer pa-test')
    expect(calls[0].body).toEqual({
      input: ['first', 'second'],
      model: 'voyage-3.5',
      input_type: 'document',
      output_dimension: 1024,
    })
  })

  it("fails ProviderCallFailed carrying Voyage's status and its own words", async () => {
    const { fetch } = recordingFetch(
      json({ detail: 'Provided API key is invalid.' }, 401),
    )
    const call = embedCallFor(
      'voyage',
      { secret: 'pa-wrong', meta: {} },
      'voyage-3.5',
      1024,
      fetch,
    )
    const failure = await Effect.runPromise(Effect.flip(call(['Spaces'])))
    expect(failure._tag).toBe('ProviderCallFailed')
    expect(providerFailure(failure.cause)).toEqual({
      status: 401,
      message: 'Provided API key is invalid.',
    })
  })

  it('fails ProviderCallFailed on an answer that is not the embeddings shape', async () => {
    const { fetch } = recordingFetch(json({ data: [{ nope: true }] }))
    const call = embedCallFor(
      'voyage',
      { secret: 'pa-test', meta: {} },
      'voyage-3.5',
      1024,
      fetch,
    )
    const failure = await Effect.runPromise(Effect.flip(call(['Spaces'])))
    expect(failure._tag).toBe('ProviderCallFailed')
  })
})
