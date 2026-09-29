import { count, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { credential } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../../vitest.seed'
import { resolveCredential, storeCredential } from '@spaces/core/writes/vault'
import {
  listAiProvidersHandler,
  saveAiKeyHandler,
  testAiProviderHandler,
} from './settings'

/**
 * SPA-29. Settings → AI → Providers, driven through the handlers the three
 * server fns delegate to, with the one thing a suite cannot build — the
 * request — stubbed: `getRequest` returns an empty request and the session
 * `requireAdmin()` reads is whichever this file says. Everything under it is
 * real: `requireAdmin` itself, the vault, the database.
 */

const session: { current: { id: string; role: string } | null } = {
  current: null,
}

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('http://localhost/settings/ai'),
}))

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

const asMember = () => {
  session.current = { id: FIXTURE_ACTOR.id, role: 'member' }
}
const asAdmin = () => {
  session.current = { id: FIXTURE_ACTOR.id, role: 'admin' }
}

const SECRET = 'sk-ant-api03-this-is-the-real-secret-9f3c'

async function credentialRows() {
  const [{ value }] = await db
    .select({ value: count() })
    .from(credential)
    .where(eq(credential.provider, 'anthropic'))
  return value
}

beforeEach(() => {
  session.current = null
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('every fn in the section refuses a non-admin', () => {
  it('refuses a member before reading or writing anything', async () => {
    asMember()
    const wire = vi.fn()
    vi.stubGlobal('fetch', wire)

    await expect(listAiProvidersHandler()).rejects.toThrow('Admins only')
    await expect(
      saveAiKeyHandler({
        provider: 'anthropic',
        key: SECRET,
        baseUrl: '',
        headers: '',
      }),
    ).rejects.toThrow('Admins only')
    await expect(
      testAiProviderHandler({ provider: 'anthropic' }),
    ).rejects.toThrow('Admins only')

    expect(await credentialRows()).toBe(0)
    expect(wire).not.toHaveBeenCalled()
  })

  it('refuses a request with no session', async () => {
    await expect(listAiProvidersHandler()).rejects.toThrow('Unauthorized')
  })
})

describe('an admin adding an Anthropic key', () => {
  it('stores one workspace credential and shows only the redacted display', async () => {
    asAdmin()
    const log = vi.spyOn(console, 'log')
    const info = vi.spyOn(console, 'info')
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')

    const saved = await saveAiKeyHandler({
      provider: 'anthropic',
      key: SECRET,
      baseUrl: 'https://gateway.fund.example/v1',
      headers: 'Helicone-Cache-Enabled: true\n',
    })
    expect(saved.display).toBe('sk-…9f3c')

    const row = (
      await db
        .select({
          scope: credential.scope,
          userId: credential.userId,
          kind: credential.kind,
          secretEnc: credential.secretEnc,
        })
        .from(credential)
        .where(eq(credential.provider, 'anthropic'))
    ).at(0)
    expect(row).toMatchObject({ scope: 'workspace', userId: null, kind: 'llm' })
    expect(row?.secretEnc.toString('utf8')).not.toContain(SECRET)

    const providers = await listAiProvidersHandler()
    expect(providers.map((p) => p.provider)).toEqual([
      'anthropic',
      'openai',
      'google',
      'openrouter',
      'ollama',
    ])
    expect(providers.filter((p) => p.configured)).toEqual([
      {
        provider: 'anthropic',
        label: 'Anthropic',
        configured: true,
        status: 'active',
        display: 'sk-…9f3c',
        baseUrl: 'https://gateway.fund.example/v1',
        headers: { 'Helicone-Cache-Enabled': 'true' },
        lastUsedAt: null,
        lastTestedAt: null,
        lastTestOk: null,
      },
    ])
    expect(JSON.stringify(providers)).not.toContain(SECRET)

    // Nothing on the save or list path printed the secret, or anything.
    for (const spy of [log, info, warn, error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET)
    }
    vi.restoreAllMocks()
  })

  it('changes the base URL without re-pasting the key, and refuses a malformed header line', async () => {
    asAdmin()
    await saveAiKeyHandler({
      provider: 'anthropic',
      baseUrl: '',
      headers: '',
    })
    const [row] = await listAiProvidersHandler()
    expect(row).toMatchObject({ display: 'sk-…9f3c', baseUrl: null })
    expect(row.headers).toEqual({})
    expect(await credentialRows()).toBe(1)

    await expect(
      saveAiKeyHandler({
        provider: 'anthropic',
        baseUrl: '',
        headers: 'no colon here',
      }),
    ).rejects.toMatchObject({
      message: 'Header line 1: expected "Name: value"',
    })
  })

  it("tests a wrong key and reads the provider's own 401, recording only the verdict", async () => {
    asAdmin()
    await saveAiKeyHandler({
      provider: 'anthropic',
      key: 'sk-ant-wrong-key-0000',
      baseUrl: '',
      headers: '',
    })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'invalid x-api-key',
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    )

    const result = await testAiProviderHandler({ provider: 'anthropic' })
    expect(result).toEqual({
      ok: false,
      status: 401,
      message: 'invalid x-api-key',
    })

    const [row] = await listAiProvidersHandler()
    expect(row.lastTestOk).toBe(false)
    expect(row.lastTestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const stored = (
      await db
        .select({ meta: credential.meta })
        .from(credential)
        .where(eq(credential.provider, 'anthropic'))
    ).at(0)
    expect(JSON.stringify(stored?.meta)).not.toContain('invalid x-api-key')
  })

  it("tests a good key and returns the model's answer, storing none of it", async () => {
    asAdmin()
    await saveAiKeyHandler({
      provider: 'anthropic',
      key: SECRET,
      baseUrl: '',
      headers: '',
    })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 9, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )

    await expect(
      testAiProviderHandler({ provider: 'anthropic' }),
    ).resolves.toEqual({ ok: true, text: 'OK' })
    const [row] = await listAiProvidersHandler()
    expect(row.lastTestOk).toBe(true)
  })
})

/** One provider's stored row, the ciphertext and the meta. */
async function storedRow(provider: string) {
  return (
    await db
      .select({ secretEnc: credential.secretEnc, meta: credential.meta })
      .from(credential)
      .where(eq(credential.provider, provider))
  ).at(0)
}

const okFromOllama = () =>
  new Response(
    JSON.stringify({
      model: 'llama3.2',
      created_at: '2026-09-23T12:00:00Z',
      message: { role: 'assistant', content: 'OK' },
      done: true,
      done_reason: 'stop',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

describe('SPA-39: an admin saving Ollama with no key', () => {
  it('saves with a base URL and an empty secret; the ledger row is configured with no display', async () => {
    asAdmin()
    const saved = await saveAiKeyHandler({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      headers: '',
    })
    expect(saved).toEqual({ display: null })

    const row = (await listAiProvidersHandler()).find(
      (p) => p.provider === 'ollama',
    )
    expect(row).toEqual({
      provider: 'ollama',
      label: 'Ollama',
      configured: true,
      status: 'active',
      display: null,
      baseUrl: 'http://localhost:11434',
      headers: {},
      lastUsedAt: null,
      lastTestedAt: null,
      lastTestOk: null,
    })

    // The column stays not-null: the row holds the encryption of '' — the
    // 29-byte envelope (version, iv, tag) with no ciphertext after it — and
    // the vault decrypts it back to ''.
    const stored = await storedRow('ollama')
    expect(stored?.secretEnc.length).toBe(1 + 12 + 16)
    expect((await resolveCredential('ollama'))?.secret).toBe('')
  })

  it('ignores a key sent for a keyless provider and keeps its headers', async () => {
    asAdmin()
    await saveAiKeyHandler({
      provider: 'ollama',
      key: 'sk-should-not-be-kept-1234',
      baseUrl: 'http://localhost:11434',
      headers: 'X-Proxy-Token: t-1',
    })
    expect((await resolveCredential('ollama'))?.secret).toBe('')
    const row = (await listAiProvidersHandler()).find(
      (p) => p.provider === 'ollama',
    )
    expect(row?.headers).toEqual({ 'X-Proxy-Token': 't-1' })
    expect(row?.display).toBeNull()
  })

  it('tests against the saved address and returns the local model answer', async () => {
    asAdmin()
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : String(input))
      return okFromOllama()
    })
    await expect(
      testAiProviderHandler({ provider: 'ollama' }),
    ).resolves.toEqual({ ok: true, text: 'OK' })
    expect(calls).toEqual(['http://localhost:11434/api/chat'])
  })

  it('surfaces a refused connection as the transport error and records the failed test', async () => {
    asAdmin()
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(
          new Error('connect ECONNREFUSED 127.0.0.1:11434'),
          { code: 'ECONNREFUSED' },
        ),
      })
    })
    await expect(
      testAiProviderHandler({ provider: 'ollama' }),
    ).resolves.toEqual({
      ok: false,
      status: null,
      message:
        'Could not reach http://localhost:11434/api/chat: connect ECONNREFUSED 127.0.0.1:11434',
    })
    const row = (await listAiProvidersHandler()).find(
      (p) => p.provider === 'ollama',
    )
    expect(row?.lastTestOk).toBe(false)
  })

  it('the vault still refuses an empty secret that is not declared keyless', async () => {
    await expect(
      storeCredential({
        scope: 'workspace',
        provider: 'openai',
        kind: 'llm',
        secret: '',
        createdBy: FIXTURE_ACTOR.id,
      }),
    ).rejects.toThrow('Secret is required')
    expect(await storedRow('openai')).toBeUndefined()
  })
})

describe('SPA-39: Google and OpenRouter keys through the same row shape', () => {
  it.each([
    {
      provider: 'google' as const,
      label: 'Google',
      key: 'AIzaSyD-google-key-7a1b',
      display: 'AIz…7a1b',
    },
    {
      provider: 'openrouter' as const,
      label: 'OpenRouter',
      key: 'sk-or-v1-openrouter-key-5c2d',
      display: 'sk-…5c2d',
    },
  ])('$label round-trips its key, base URL and headers', async (c) => {
    asAdmin()
    const saved = await saveAiKeyHandler({
      provider: c.provider,
      key: c.key,
      baseUrl: 'https://gateway.fund.example/v1',
      headers: 'Helicone-Auth: Bearer hc-1',
    })
    expect(saved).toEqual({ display: c.display })

    const row = (await listAiProvidersHandler()).find(
      (p) => p.provider === c.provider,
    )
    expect(row).toEqual({
      provider: c.provider,
      label: c.label,
      configured: true,
      status: 'active',
      display: c.display,
      baseUrl: 'https://gateway.fund.example/v1',
      headers: { 'Helicone-Auth': 'Bearer hc-1' },
      lastUsedAt: null,
      lastTestedAt: null,
      lastTestOk: null,
    })
    expect(JSON.stringify(row)).not.toContain(c.key)
    expect((await resolveCredential(c.provider))?.secret).toBe(c.key)

    // Saved, a keyless save changes the base URL and keeps the key.
    await saveAiKeyHandler({ provider: c.provider, baseUrl: '', headers: '' })
    expect((await resolveCredential(c.provider))?.secret).toBe(c.key)
    const after = (await listAiProvidersHandler()).find(
      (p) => p.provider === c.provider,
    )
    expect(after).toMatchObject({ display: c.display, baseUrl: null })
  })

  it('refuses a keyed provider saved for the first time without a key', async () => {
    asAdmin()
    await expect(
      saveAiKeyHandler({ provider: 'openai', baseUrl: '', headers: '' }),
    ).rejects.toMatchObject({ message: 'Paste a OpenAI key first' })
  })
})
