import { Effect, Schema } from 'effect'
import {
  mergeCredentialMeta,
  readWorkspaceCredential,
  redact,
  storeCredential,
} from '#/lib/vault'
import type { CredentialMeta } from '@spaces/db/schema/vault'
import { effectFn } from '#/lib/server/effect'
import { requireAdmin } from '#/lib/server/shared'
import { BUILT_LLM_PROVIDERS, PROVIDER_LABEL } from './ids'
import type { AiKeyInput, LlmProvider } from './ids'
import { resolveLanguageModel } from './index'
import { parseHeaderLines, readProviderMeta } from './meta'
import { runTestCall } from './test-call'
import type { TestCallResult } from './test-call'

/**
 * Settings → AI → Providers (SPA-29): the three operations behind the
 * ledger. Every one of them is admin-only — keys are the admin's
 * (CONTEXT.md: admin owns settings, integrations, keys) — and the refusal is
 * `requireAdmin()`, the first line of each handler below, before any read.
 *
 * The handlers live here rather than in `lib/server/ai-settings.ts` so a test
 * can drive them without a request: `lib/server/*` exports ship to the
 * browser, and the server fns there are one-line delegations.
 *
 * The secret goes in and never comes back out: the ledger reads the redacted
 * `display` stored on `meta` at save time, nothing here decrypts except the
 * Test call, and no line in this module logs.
 */

export class AiSettingsRefused extends Schema.TaggedError<AiSettingsRefused>()(
  'AiSettingsRefused',
  { message: Schema.String },
) {}

export class AiSettingsWriteFailed extends Schema.TaggedError<AiSettingsWriteFailed>()(
  'AiSettingsWriteFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

export type AiProviderRow = {
  provider: LlmProvider
  label: string
  configured: boolean
  status: 'active' | 'invalid' | null
  display: string | null
  baseUrl: string | null
  headers: Record<string, string>
  lastUsedAt: string | null
  lastTestedAt: string | null
  lastTestOk: boolean | null
}

const write = <T>(message: string, f: () => Promise<T>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new AiSettingsWriteFailed({ message, cause }),
  })

export const listAiProvidersProgram = Effect.fn('listAiProviders')(
  function* (): Effect.fn.Return<AiProviderRow[], AiSettingsWriteFailed> {
    const rows: AiProviderRow[] = []
    for (const provider of BUILT_LLM_PROVIDERS) {
      const row = yield* write('Could not read the providers', () =>
        readWorkspaceCredential(provider),
      )
      const meta = row ? readProviderMeta(row.meta) : null
      rows.push({
        provider,
        label: PROVIDER_LABEL[provider],
        configured: row !== undefined,
        status: row?.status ?? null,
        display: meta?.display ?? null,
        baseUrl: meta?.baseUrl ?? null,
        headers: meta?.headers ?? {},
        lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
        lastTestedAt: meta?.lastTestedAt ?? null,
        lastTestOk: meta?.lastTestOk ?? null,
      })
    }
    return rows
  },
)

export const saveAiKeyProgram = Effect.fn('saveAiKey')(function* (
  actorId: string,
  data: AiKeyInput,
): Effect.fn.Return<
  { display: string | null },
  AiSettingsRefused | AiSettingsWriteFailed
> {
  const parsed = parseHeaderLines(data.headers)
  if (!parsed.ok) return yield* new AiSettingsRefused({ message: parsed.error })
  const hasHeaders = Object.keys(parsed.headers).length > 0

  const key = data.key
  if (key) {
    const display = redact(key)
    const meta: CredentialMeta = { display }
    if (data.baseUrl) meta.baseUrl = data.baseUrl
    if (hasHeaders) meta.headers = parsed.headers
    yield* write('Could not save the key', () =>
      storeCredential({
        scope: 'workspace',
        provider: data.provider,
        kind: 'llm',
        secret: key,
        meta,
        createdBy: actorId,
      }),
    )
    return { display }
  }

  // No key: the base URL and headers change on the key already saved. A
  // null clears the stored value — `readProviderMeta` reads it as absent.
  const existing = yield* write('Could not read the provider', () =>
    readWorkspaceCredential(data.provider),
  )
  if (!existing)
    return yield* new AiSettingsRefused({
      message: `Paste a ${PROVIDER_LABEL[data.provider]} key first`,
    })
  yield* write('Could not save the provider', () =>
    mergeCredentialMeta(existing.id, {
      baseUrl: data.baseUrl || null,
      headers: hasHeaders ? parsed.headers : null,
    }),
  )
  return { display: readProviderMeta(existing.meta).display ?? null }
})

/**
 * One tiny prompt through the saved credential. The verdict and its time are
 * written onto the credential's `meta`; the answer and the provider's error
 * text go back to the admin and are stored nowhere.
 */
export const testAiProviderProgram = Effect.fn('testAiProvider')(function* (
  provider: LlmProvider,
): Effect.fn.Return<TestCallResult, AiSettingsWriteFailed> {
  const resolved = yield* resolveLanguageModel(provider).pipe(
    Effect.catchTag('NoCredential', () => Effect.succeed(null)),
    Effect.catchTag('ProviderNotBuilt', () => Effect.succeed(null)),
    Effect.catchTag('CredentialReadFailed', (e) =>
      Effect.fail(
        new AiSettingsWriteFailed({
          message: 'Could not read the credential',
          cause: e.cause,
        }),
      ),
    ),
  )
  if (!resolved)
    return {
      ok: false,
      status: null,
      message: `No ${PROVIDER_LABEL[provider]} key is saved`,
    }

  const result = yield* runTestCall(resolved.model)
  yield* write('Could not record the test', () =>
    mergeCredentialMeta(resolved.credentialId, {
      lastTestedAt: new Date().toISOString(),
      lastTestOk: result.ok,
    }),
  )
  return result
})

// The server fns' bodies. `requireAdmin()` first, always.

export async function listAiProvidersHandler(): Promise<AiProviderRow[]> {
  await requireAdmin()
  return effectFn(listAiProvidersProgram)()
}

export async function saveAiKeyHandler(
  data: AiKeyInput,
): Promise<{ display: string | null }> {
  const admin = await requireAdmin()
  return effectFn(saveAiKeyProgram)(admin.id, data)
}

export async function testAiProviderHandler(data: {
  provider: LlmProvider
}): Promise<TestCallResult> {
  await requireAdmin()
  return effectFn(testAiProviderProgram)(data.provider)
}
