import { Effect } from 'effect'
import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { aiUsage, credential, workspace } from '@spaces/db/schema'
import type { WorkspaceSettings } from '@spaces/db/schema/workspace'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { fakeOllama } from '#/test/fake-ollama'
import { readWorkspaceCredential } from '#/lib/vault'
import { embedMessage, embedProgram } from './embed'
import {
  clearSensitiveSlotProgram,
  pinEmbeddingProgram,
  readEmbeddingSetupProgram,
  setSensitiveSlotProgram,
} from './embedding-pin'
import { saveAiKeyProgram } from './providers/settings'
import { readProviderMeta } from './providers/meta'
import {
  PIN_DIMS,
  findEmbeddingModel,
  needsRepinNote,
  ollamaNotPulledMessage,
} from './providers/embed/ids'
import type { EmbeddingTarget } from './providers/embed/ids'
import {
  getEmbeddingSettingsProgram,
  saveEmbeddingKeyProgram,
  testEmbeddingProgram,
} from './providers/embed/settings'

/**
 * SPA-83. The Ollama embedding adapter and the sensitive slot, against
 * Postgres and an in-repo fake of `/api/embed` (`#/test/fake-ollama`)
 * stubbed over the global `fetch` — so the real path runs: the Providers
 * section's keyless Ollama row → `resolveEmbedCall` → the adapter → the
 * fake. Nothing reaches a network.
 */

const NOMIC: EmbeddingTarget = { provider: 'ollama', model: 'nomic-embed-text' }
const MXBAI: EmbeddingTarget = {
  provider: 'ollama',
  model: 'mxbai-embed-large',
}

async function setSettings(settings: WorkspaceSettings) {
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

async function storedSettings(): Promise<WorkspaceSettings> {
  return (
    (await db.select({ s: workspace.settings }).from(workspace)).at(0)?.s ?? {}
  )
}

/** Ollama saved the way Settings → AI · Providers saves it: an address, no key. */
const saveOllama = (baseUrl = 'http://ollama:11434') =>
  Effect.runPromise(
    saveAiKeyProgram(FIXTURE_ACTOR.id, {
      provider: 'ollama',
      baseUrl,
      headers: '',
    }),
  )

const runTest = (target: EmbeddingTarget) =>
  Effect.runPromise(testEmbeddingProgram(FIXTURE_ACTOR.id, target))

/** A cloud pin: OpenAI text-embedding-3-small at 768. */
async function pinOpenAi(model = 'text-embedding-3-small') {
  await Effect.runPromise(
    saveEmbeddingKeyProgram(FIXTURE_ACTOR.id, {
      provider: 'openai',
      key: 'sk-embed-test-0000',
    }),
  )
  return Effect.runPromise(pinEmbeddingProgram({ provider: 'openai', model }))
}

/** A green Ollama Test, then the slot set to it. */
async function setSlot() {
  await saveOllama()
  vi.stubGlobal('fetch', fakeOllama({ pulled: ['nomic-embed-text'] }).fetch)
  expect((await runTest(NOMIC)).ok).toBe(true)
  vi.unstubAllGlobals()
  return Effect.runPromise(setSensitiveSlotProgram(NOMIC))
}

beforeEach(async () => {
  await setSettings({})
  await db.delete(aiUsage).where(lte(aiUsage.at, new Date()))
  await db.delete(credential).where(isNotNull(credential.id))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Test call through Ollama', () => {
  it('returns a 768-wide vector for nomic-embed-text through the Providers row, and records the verdict apart from the LLM Test', async () => {
    await saveOllama()
    const ollama = fakeOllama({ pulled: ['nomic-embed-text'] })
    vi.stubGlobal('fetch', ollama.fetch)

    const result = await runTest(NOMIC)
    expect(result).toMatchObject({
      ok: true,
      model: 'nomic-embed-text',
      width: 768,
    })
    expect(ollama.calls).toEqual([
      {
        url: 'http://ollama:11434/api/embed',
        body: { model: 'nomic-embed-text', input: ['Spaces'] },
      },
    ])
    const usage = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.lane, 'embed'), eq(aiUsage.provider, 'ollama')))
    expect(usage).toHaveLength(1)

    // One credential row — the LLM provider's — and no `embed:ollama`.
    const rows = await db
      .select({ provider: credential.provider, kind: credential.kind })
      .from(credential)
    expect(rows).toEqual([{ provider: 'ollama', kind: 'llm' }])
    const row = await readWorkspaceCredential('ollama')
    if (!row) throw new Error('the Ollama row is gone')
    const meta = readProviderMeta(row.meta)
    expect(meta).toMatchObject({
      baseUrl: 'http://ollama:11434',
      embedTestOk: true,
      embedTestModel: 'nomic-embed-text',
    })
    // The LLM Test's verdict is its own, and this Test did not write it.
    expect(meta.lastTestOk).toBeUndefined()

    const view = await Effect.runPromise(getEmbeddingSettingsProgram())
    expect(view.keys.find((k) => k.provider === 'ollama')).toMatchObject({
      configured: true,
      baseUrl: 'http://ollama:11434',
      lastTestOk: true,
      testedModel: 'nomic-embed-text',
    })
  })

  it('turns the 404 for a model that is not pulled into the ollama pull command', async () => {
    await saveOllama()
    vi.stubGlobal('fetch', fakeOllama({ pulled: [] }).fetch)

    const result = await runTest(NOMIC)
    expect(result).toEqual({
      ok: false,
      status: 404,
      message: ollamaNotPulledMessage('nomic-embed-text'),
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('ollama pull nomic-embed-text')
    const row = await readWorkspaceCredential('ollama')
    expect(readProviderMeta(row?.meta ?? {}).embedTestOk).toBe(false)
  })

  it('names the URL it could not reach, in one attempt', async () => {
    await saveOllama('http://10.9.9.9:11434')
    const ollama = fakeOllama({
      pulled: ['nomic-embed-text'],
      unreachable: true,
    })
    vi.stubGlobal('fetch', ollama.fetch)

    const result = await runTest(NOMIC)
    expect(result).toMatchObject({ ok: false, status: null })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('http://10.9.9.9:11434/api/embed')
    expect(result.message).toContain('ECONNREFUSED')
    expect(ollama.calls).toHaveLength(1)
  })

  it('is inert until an Ollama credential exists: no call, the address asked for', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await runTest(NOMIC)).toEqual({
      ok: false,
      status: null,
      message: 'No Ollama address is saved',
    })
    expect(fetch).not.toHaveBeenCalled()
    const view = await Effect.runPromise(getEmbeddingSettingsProgram())
    expect(view.keys.find((k) => k.provider === 'ollama')).toMatchObject({
      configured: false,
      lastTestOk: null,
    })
    expect(view.slot).toBeNull()
  })
})

describe('the Ollama ledger', () => {
  it('greys mxbai-embed-large with the re-pin note and never calls it', async () => {
    const mxbai = findEmbeddingModel('ollama', 'mxbai-embed-large')
    if (!mxbai) throw new Error('mxbai-embed-large is not in the catalogue')
    expect(mxbai.emitsPin).toBe(false)
    expect(needsRepinNote(mxbai)).toBe(
      'needs re-pin — emits 1024, this workspace stores 768',
    )
    await saveOllama()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await runTest(MXBAI)).toEqual({
      ok: false,
      status: null,
      message: 'needs re-pin — emits 1024, this workspace stores 768',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses to pin mxbai-embed-large: PinLocked beside a pin, PinRefused with none', async () => {
    await saveOllama()
    const none = await Effect.runPromise(
      Effect.flip(pinEmbeddingProgram(MXBAI)),
    )
    expect(none._tag).toBe('PinRefused')
    expect(none.message).toContain('needs re-pin — emits 1024')

    const pinned = await Effect.runPromise(pinEmbeddingProgram(NOMIC))
    expect(pinned).toMatchObject({ provider: 'ollama', dims: 768 })
    const locked = await Effect.runPromise(
      Effect.flip(pinEmbeddingProgram(MXBAI)),
    )
    expect(locked._tag).toBe('PinLocked')
    expect(locked.message).toContain('mxbai-embed-large emits 1024')
  })

  it('asks for the Providers address, not a key, before pinning Ollama', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(pinEmbeddingProgram(NOMIC)),
    )
    expect(failure).toMatchObject({
      _tag: 'PinRefused',
      message:
        'Save the Ollama address under Settings → AI · Providers before pinning',
    })
  })
})

describe('the sensitive slot', () => {
  it('is stored beside the pin, read back, kept across a same-width swap, and cleared', async () => {
    const pin = await pinOpenAi()
    const slot = await setSlot()
    expect(slot).toMatchObject({
      provider: 'ollama',
      model: 'nomic-embed-text',
      dims: 768,
    })

    const stored = await storedSettings()
    expect(stored.embedding).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dims: 768,
      pinned_at: pin.pinnedAt,
      sensitive: {
        provider: 'ollama',
        model: 'nomic-embed-text',
        dims: 768,
        set_at: slot.setAt,
      },
    })
    expect(
      (await Effect.runPromise(getEmbeddingSettingsProgram())).slot,
    ).toEqual(slot)

    // Setting it again is a no-op.
    expect(await Effect.runPromise(setSensitiveSlotProgram(NOMIC))).toEqual(
      slot,
    )

    // A swap merges into `embedding`; the slot beside it stays.
    await Effect.runPromise(
      pinEmbeddingProgram({
        provider: 'openai',
        model: 'text-embedding-3-large',
      }),
    )
    expect(await Effect.runPromise(readEmbeddingSetupProgram())).toMatchObject({
      pin: { model: 'text-embedding-3-large' },
      slot,
    })

    await Effect.runPromise(clearSensitiveSlotProgram())
    expect(
      (await Effect.runPromise(readEmbeddingSetupProgram())).slot,
    ).toBeNull()
    expect((await storedSettings()).embedding).not.toHaveProperty('sensitive')
  })

  it('refuses a width that is not the pin’s, naming both numbers', async () => {
    await pinOpenAi()
    await saveOllama()
    const failure = await Effect.runPromise(
      Effect.flip(setSensitiveSlotProgram(MXBAI)),
    )
    expect(failure).toMatchObject({
      _tag: 'SlotRefused',
      message:
        "Ollama mxbai-embed-large emits 1024; the pin stores 768. The sensitive slot must match the pin's width.",
    })
  })

  it('refuses before a pin, a cloud provider, a missing address and an untested model', async () => {
    const refusal = async (target: EmbeddingTarget) =>
      (await Effect.runPromise(Effect.flip(setSensitiveSlotProgram(target))))
        .message

    expect(await refusal(NOMIC)).toBe(
      'Pin an embedding model before setting the sensitive slot',
    )
    await pinOpenAi()
    expect(
      await refusal({ provider: 'google', model: 'text-embedding-004' }),
    ).toBe(
      'Google is a cloud provider; the sensitive slot takes only a model that runs on a box you run',
    )
    expect(await refusal(NOMIC)).toBe(
      'Save the Ollama address under Settings → AI · Providers before setting the sensitive slot',
    )
    await saveOllama()
    expect(await refusal(NOMIC)).toBe(
      'Test Ollama nomic-embed-text before setting it as the sensitive slot',
    )
    // A red Test does not count either.
    vi.stubGlobal('fetch', fakeOllama({ pulled: [] }).fetch)
    expect((await runTest(NOMIC)).ok).toBe(false)
    expect(await refusal(NOMIC)).toBe(
      'Test Ollama nomic-embed-text before setting it as the sensitive slot',
    )
    expect((await Effect.runPromise(readEmbeddingSetupProgram())).slot).toBe(
      null,
    )
  })
})

describe('embed() and the slot', () => {
  it('routes a sensitive embed to the slot and answers its vectors', async () => {
    await pinOpenAi()
    await setSlot()
    const ollama = fakeOllama({ pulled: ['nomic-embed-text'] })
    vi.stubGlobal('fetch', ollama.fetch)

    const result = await Effect.runPromise(
      embedProgram(['Vault memo', 'Term sheet'], {
        caller: { type: 'system' },
        sensitivity: 'sensitive',
      }),
    )
    expect(result.target).toEqual({
      provider: 'ollama',
      model: 'nomic-embed-text',
      dims: 768,
    })
    expect(result.vectors.map((v) => v.length)).toEqual([768, 768])
    expect(ollama.calls.map((c) => c.url)).toEqual([
      'http://ollama:11434/api/embed',
    ])
    const usage = await db
      .select({ provider: aiUsage.provider, model: aiUsage.model })
      .from(aiUsage)
      .where(eq(aiUsage.callerType, 'system'))
    expect(usage).toEqual([{ provider: 'ollama', model: 'nomic-embed-text' }])
  })

  it('with no slot still refuses a sensitive embed with the existing message, and sends nothing anywhere', async () => {
    await pinOpenAi()
    await saveOllama()
    const ollama = fakeOllama({ pulled: ['nomic-embed-text'] })
    vi.stubGlobal('fetch', ollama.fetch)

    const failure = await Effect.runPromise(
      Effect.flip(
        embedProgram(['Vault memo'], {
          caller: { type: 'system' },
          sensitivity: 'sensitive',
        }),
      ),
    )
    expect(failure).toMatchObject({
      _tag: 'SensitiveRouteRefused',
      provider: 'openai',
    })
    expect(embedMessage(failure)).toBe(
      'Sensitive material is not sent to OpenAI for embedding; it is left unembedded until a local embedding model is set up',
    )
    expect(ollama.calls).toHaveLength(0)
  })

  it('sends a sensitive embed straight to a local pin, with no slot needed', async () => {
    await saveOllama()
    await Effect.runPromise(pinEmbeddingProgram(NOMIC))
    const ollama = fakeOllama({ pulled: ['nomic-embed-text'] })
    vi.stubGlobal('fetch', ollama.fetch)

    const result = await Effect.runPromise(
      embedProgram(['Vault memo'], {
        caller: { type: 'system' },
        sensitivity: 'sensitive',
      }),
    )
    expect(result.target.provider).toBe('ollama')
    expect(ollama.calls).toHaveLength(1)
    expect(PIN_DIMS).toBe(result.vectors[0]?.length)
  })
})
