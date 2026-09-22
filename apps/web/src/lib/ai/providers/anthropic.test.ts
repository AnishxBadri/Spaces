import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_ACTOR } from '../../../../vitest.seed'
import { storeCredential } from '#/lib/vault'
import { resolveLanguageModel } from './index'
import {
  ANTHROPIC_DEFAULT_MODEL,
  anthropicLanguageModel,
} from './llm/anthropic'
import { TEST_PROMPT, runTestCall } from './test-call'

/**
 * SPA-29. The Anthropic adapter carries a credential's `meta` — base URL and
 * extra headers, the gateway passthrough of `docs/spec-ai-substrate.md` §9 —
 * onto the AI SDK client it constructs. Asserted on the wire: a stub `fetch`
 * records the one request the client makes and answers it with a canned
 * Messages API body, so nothing leaves the process.
 */

type Recorded = { url: string; headers: Headers; body: unknown }

/** A transport that records the request and answers with `reply`. */
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

const okReply = () =>
  new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: ANTHROPIC_DEFAULT_MODEL,
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 9, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

/** What api.anthropic.com answers a wrong key with. */
const wrongKeyReply = () =>
  new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  )

const BASE_URL = 'https://gateway.fund.example/anthropic/v1'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Anthropic adapter', () => {
  it('sends to the credential base URL with its custom header and the vault key', async () => {
    const wire = recordingFetch(okReply)
    const model = anthropicLanguageModel({
      secret: 'sk-ant-test-0123456789',
      meta: { baseUrl: BASE_URL, headers: { 'Helicone-Auth': 'Bearer hc-1' } },
      fetch: wire.fetch,
    })

    const result = await Effect.runPromise(runTestCall(model))

    expect(result).toEqual({ ok: true, text: 'OK' })
    expect(wire.calls).toHaveLength(1)
    const [call] = wire.calls
    expect(call.url).toBe(`${BASE_URL}/messages`)
    expect(call.headers.get('helicone-auth')).toBe('Bearer hc-1')
    expect(call.headers.get('x-api-key')).toBe('sk-ant-test-0123456789')
    expect(call.body).toMatchObject({
      model: ANTHROPIC_DEFAULT_MODEL,
      messages: [
        { role: 'user', content: [{ type: 'text', text: TEST_PROMPT }] },
      ],
    })
  })

  it('without a base URL talks to Anthropic itself', async () => {
    const wire = recordingFetch(okReply)
    const model = anthropicLanguageModel({
      secret: 'sk-ant-test-0123456789',
      meta: {},
      fetch: wire.fetch,
    })
    await Effect.runPromise(runTestCall(model))
    expect(wire.calls[0].url).toBe('https://api.anthropic.com/v1/messages')
  })

  it("surfaces a wrong key's 401 in the provider's own words", async () => {
    const wire = recordingFetch(wrongKeyReply)
    const model = anthropicLanguageModel({
      secret: 'sk-ant-wrong',
      meta: {},
      fetch: wire.fetch,
    })

    const result = await Effect.runPromise(runTestCall(model))

    expect(result).toEqual({
      ok: false,
      status: 401,
      message: 'invalid x-api-key',
    })
    // One attempt — a Test button does not retry.
    expect(wire.calls).toHaveLength(1)
  })
})

describe('resolveLanguageModel', () => {
  // First: the file's database is truncated once, before the file, so this
  // has to run before the next test stores a key.
  it('fails NoCredential when the vault has no key, rather than reading the environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-env-must-not-be-used')
    const exit = await Effect.runPromiseExit(resolveLanguageModel('anthropic'))
    vi.unstubAllEnvs()
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('NoCredential')
  })

  it('builds the client from the vault row: key, base URL and header all reach the wire', async () => {
    await storeCredential({
      scope: 'workspace',
      provider: 'anthropic',
      kind: 'llm',
      secret: 'sk-ant-from-the-vault-42',
      meta: { baseUrl: BASE_URL, headers: { 'X-Gateway-Team': 'spaces' } },
      createdBy: FIXTURE_ACTOR.id,
    })
    // The adapter takes no transport here — this is the production path —
    // so the global one is what gets stubbed.
    const wire = recordingFetch(okReply)
    vi.stubGlobal('fetch', wire.fetch)

    const { model } = await Effect.runPromise(resolveLanguageModel('anthropic'))
    const result = await Effect.runPromise(runTestCall(model))

    expect(result).toEqual({ ok: true, text: 'OK' })
    expect(wire.calls).toHaveLength(1)
    expect(wire.calls[0].url).toBe(`${BASE_URL}/messages`)
    expect(wire.calls[0].headers.get('x-gateway-team')).toBe('spaces')
    expect(wire.calls[0].headers.get('x-api-key')).toBe(
      'sk-ant-from-the-vault-42',
    )
  })
})
