import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { PROVIDERS } from './ids'
import { languageModelFor } from './index'
import type { AdapterInput } from './llm/adapter'
import { GOOGLE_DEFAULT_MODEL, googleLanguageModel } from './llm/google'
import {
  OLLAMA_DEFAULT_MODEL,
  ollamaApiRoot,
  ollamaLanguageModel,
} from './llm/ollama'
import { OPENAI_DEFAULT_MODEL, openaiLanguageModel } from './llm/openai'
import {
  OPENROUTER_DEFAULT_MODEL,
  openrouterLanguageModel,
} from './llm/openrouter'
import { TEST_PROMPT, providerFailure, runTestCall } from './test-call'

/**
 * SPA-39. The four adapters after Anthropic, each asserted against the
 * client it constructs: a stub transport records the one request and answers
 * with a canned body in that provider's wire format, so the base URL, the
 * extra headers, the key and the model id are read off the request with no
 * network and no database row.
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

/** Chat Completions — what OpenAI and OpenRouter both answer with. */
const chatCompletion = json({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1758585600,
  model: 'test-model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'OK' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
})

const geminiReply = json({
  candidates: [
    {
      content: { role: 'model', parts: [{ text: 'OK' }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 9,
    candidatesTokenCount: 1,
    totalTokenCount: 10,
  },
})

const ollamaReply = json({
  model: OLLAMA_DEFAULT_MODEL,
  created_at: '2026-09-23T12:00:00Z',
  message: { role: 'assistant', content: 'OK' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 9,
  eval_count: 1,
})

const GATEWAY = 'https://gateway.fund.example/v1'
const HEADERS = { 'Helicone-Auth': 'Bearer hc-1' }

async function send(
  adapter: (input: AdapterInput) => ReturnType<typeof openaiLanguageModel>,
  input: Omit<AdapterInput, 'fetch'>,
  reply: () => Response,
) {
  const wire = recordingFetch(reply)
  const model = adapter({ ...input, fetch: wire.fetch })
  const result = await Effect.runPromise(runTestCall(model))
  expect(wire.calls).toHaveLength(1)
  return { result, call: wire.calls[0] }
}

describe('the OpenAI adapter', () => {
  it('sends Chat Completions to the base URL with the header, the vault key and the model id', async () => {
    const { result, call } = await send(
      openaiLanguageModel,
      {
        secret: 'sk-openai-0123',
        meta: { baseUrl: GATEWAY, headers: HEADERS },
      },
      chatCompletion,
    )
    expect(result).toEqual({ ok: true, text: 'OK' })
    expect(call.url).toBe(`${GATEWAY}/chat/completions`)
    expect(call.headers.get('authorization')).toBe('Bearer sk-openai-0123')
    expect(call.headers.get('helicone-auth')).toBe('Bearer hc-1')
    expect(call.body).toMatchObject({
      model: OPENAI_DEFAULT_MODEL,
      messages: [{ role: 'user', content: TEST_PROMPT }],
    })
  })

  it('without a base URL talks to OpenAI, and takes a named model', async () => {
    const { call } = await send(
      openaiLanguageModel,
      { secret: 'sk-openai-0123', meta: {}, modelId: 'gpt-5.4-mini' },
      chatCompletion,
    )
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call.body).toMatchObject({ model: 'gpt-5.4-mini' })
  })
})

describe('the Google adapter', () => {
  it('sends to the base URL with the key in a header, never the URL', async () => {
    const { result, call } = await send(
      googleLanguageModel,
      {
        secret: 'AIza-google-0123',
        meta: { baseUrl: GATEWAY, headers: HEADERS },
      },
      geminiReply,
    )
    expect(result).toEqual({ ok: true, text: 'OK' })
    expect(call.url).toBe(
      `${GATEWAY}/models/${GOOGLE_DEFAULT_MODEL}:generateContent`,
    )
    expect(call.url).not.toContain('AIza')
    expect(call.headers.get('x-goog-api-key')).toBe('AIza-google-0123')
    expect(call.headers.get('helicone-auth')).toBe('Bearer hc-1')
    expect(call.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
    })
  })

  it('without a base URL talks to the Gemini API', async () => {
    const { call } = await send(
      googleLanguageModel,
      { secret: 'AIza-google-0123', meta: {} },
      geminiReply,
    )
    expect(call.url).toBe(
      `${PROVIDERS.google.defaultBaseUrl}/models/${GOOGLE_DEFAULT_MODEL}:generateContent`,
    )
  })
})

describe('the OpenRouter adapter', () => {
  it('sends to the base URL with the header, the vault key and the model id', async () => {
    const { result, call } = await send(
      openrouterLanguageModel,
      {
        secret: 'sk-or-v1-0123',
        meta: { baseUrl: GATEWAY, headers: HEADERS },
      },
      chatCompletion,
    )
    expect(result).toEqual({ ok: true, text: 'OK' })
    expect(call.url).toBe(`${GATEWAY}/chat/completions`)
    expect(call.headers.get('authorization')).toBe('Bearer sk-or-v1-0123')
    expect(call.headers.get('helicone-auth')).toBe('Bearer hc-1')
    // No attribution header unless the operator adds one.
    expect(call.headers.get('http-referer')).toBeNull()
    expect(call.body).toMatchObject({ model: OPENROUTER_DEFAULT_MODEL })
  })

  it('without a base URL talks to OpenRouter', async () => {
    const { call } = await send(
      openrouterLanguageModel,
      { secret: 'sk-or-v1-0123', meta: {} },
      chatCompletion,
    )
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions')
  })
})

describe('the Ollama adapter', () => {
  it('sends to the server address under /api, with no key and the model id', async () => {
    const { result, call } = await send(
      ollamaLanguageModel,
      {
        secret: '',
        meta: { baseUrl: 'http://localhost:11434', headers: HEADERS },
      },
      ollamaReply,
    )
    expect(result).toEqual({ ok: true, text: 'OK' })
    expect(call.url).toBe('http://localhost:11434/api/chat')
    expect(call.headers.get('authorization')).toBeNull()
    expect(call.headers.get('helicone-auth')).toBe('Bearer hc-1')
    expect(call.body).toMatchObject({
      model: OLLAMA_DEFAULT_MODEL,
      stream: false,
    })
  })

  it('reads the API root off whatever the operator typed', () => {
    expect(ollamaApiRoot('http://localhost:11434')).toBe(
      'http://localhost:11434/api',
    )
    expect(ollamaApiRoot('http://localhost:11434/')).toBe(
      'http://localhost:11434/api',
    )
    expect(ollamaApiRoot('https://gw.fund.example/ollama/api/')).toBe(
      'https://gw.fund.example/ollama/api',
    )
  })

  it("surfaces Ollama's own words for a model it has not pulled", async () => {
    const { result } = await send(
      ollamaLanguageModel,
      { secret: '', meta: {} },
      json({ error: 'model "llama3.2" not found, try pulling it first' }, 404),
    )
    expect(result).toEqual({
      ok: false,
      status: 404,
      message: 'model "llama3.2" not found, try pulling it first',
    })
  })
})

describe('languageModelFor', () => {
  it('dispatches every provider to its own adapter', () => {
    const credential = { secret: 'k-0123456789', meta: {} }
    expect(languageModelFor('anthropic', credential)).toMatchObject({
      provider: 'anthropic.messages',
    })
    expect(languageModelFor('openai', credential)).toMatchObject({
      provider: 'openai.chat',
      modelId: OPENAI_DEFAULT_MODEL,
    })
    expect(languageModelFor('google', credential)).toMatchObject({
      modelId: GOOGLE_DEFAULT_MODEL,
    })
    expect(languageModelFor('openrouter', credential)).toMatchObject({
      provider: 'openrouter',
      modelId: OPENROUTER_DEFAULT_MODEL,
    })
    expect(languageModelFor('ollama', credential, 'qwen3:8b')).toMatchObject({
      modelId: 'qwen3:8b',
    })
  })
})

/**
 * A base URL nobody answers at. Node's fetch rejects `TypeError: fetch
 * failed` and puts the reason one `cause` down; the admin reads that reason
 * and the URL, not "the provider refused".
 */
function refusedFetch(address: string) {
  return async (): Promise<Response> => {
    const cause = Object.assign(new Error(`connect ECONNREFUSED ${address}`), {
      code: 'ECONNREFUSED',
    })
    throw new TypeError('fetch failed', { cause })
  }
}

describe('an unreachable base URL', () => {
  it('surfaces the transport error text and the URL it tried', async () => {
    const model = ollamaLanguageModel({
      secret: '',
      meta: { baseUrl: 'http://localhost:11434' },
      fetch: refusedFetch('127.0.0.1:11434'),
    })
    const result = await Effect.runPromise(runTestCall(model))
    expect(result).toEqual({
      ok: false,
      status: null,
      message:
        'Could not reach http://localhost:11434/api/chat: connect ECONNREFUSED 127.0.0.1:11434',
    })
  })

  it('does the same for a keyed provider pointed at a dead gateway', async () => {
    const model = openaiLanguageModel({
      secret: 'sk-openai-0123',
      meta: { baseUrl: 'http://127.0.0.1:9' },
      fetch: refusedFetch('127.0.0.1:9'),
    })
    const result = await Effect.runPromise(runTestCall(model))
    expect(result).toMatchObject({ ok: false, status: null })
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('ECONNREFUSED 127.0.0.1:9')
    expect(result.message).not.toBe('The provider refused')
  })

  it('names the code when a bare transport error reaches it unwrapped', () => {
    const cause = Object.assign(new Error('getaddrinfo failed'), {
      code: 'ENOTFOUND',
    })
    expect(providerFailure(new TypeError('socket hang up', { cause }))).toEqual(
      { status: null, message: 'ENOTFOUND: getaddrinfo failed' },
    )
  })
})
