import { Effect, Schema } from 'effect'
import {
  mergeCredentialMeta,
  readWorkspaceCredential,
  redact,
  storeCredential,
} from '#/lib/vault'
import { effectFn } from '#/lib/server/effect'
import { requireAdmin } from '#/lib/server/shared'
import { embedMessage, embedProgram } from '../../embed'
import {
  pinEmbeddingProgram,
  readEmbeddingPinProgram,
} from '../../embedding-pin'
import { readProviderMeta } from '../meta'
import { providerFailure } from '../test-call'
import {
  EMBEDDING_PROVIDERS,
  EMBEDDING_PROVIDER_INFO,
  embeddingCredentialProvider,
  findEmbeddingModel,
  needsRepinNote,
} from './ids'
import type {
  EmbeddingKeyInput,
  EmbeddingPinView,
  EmbeddingProvider,
  EmbeddingTarget,
} from './ids'

/**
 * Settings → AI · Embeddings (SPA-51): the four operations behind the
 * section — read, save a key, test a model, pin. Admin-only, every one:
 * `requireAdmin()` is the first line of each handler below. They live here,
 * not in `lib/server/ai-settings.ts`, so a test can drive them without a
 * request and so the AI SDK never reaches the client bundle; the server fns
 * there are one-line delegations.
 *
 * An embedding key is its own vault row — `kind: 'embedding'`, provider
 * `embed:<id>` (`embeddingCredentialProvider`) — never the LLM key of the
 * same vendor, which it would otherwise overwrite. As with the LLM keys, the
 * secret goes in and never comes back out: the section reads the redacted
 * `display`.
 */

/** A read or write behind the section failed; `message` is what it is shown. */
export class EmbeddingSettingsFailed extends Schema.TaggedError<EmbeddingSettingsFailed>()(
  'EmbeddingSettingsFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

export type EmbeddingKeyRow = {
  provider: EmbeddingProvider
  label: string
  configured: boolean
  display: string | null
  lastTestedAt: string | null
  lastTestOk: boolean | null
}

export type EmbeddingSettingsView = {
  pin: EmbeddingPinView | null
  keys: EmbeddingKeyRow[]
}

export type EmbeddingTestResult =
  | { ok: true; model: string; width: number; head: number[] }
  | { ok: false; status: number | null; message: string }

const readKey = (provider: EmbeddingProvider) =>
  Effect.tryPromise({
    try: () => readWorkspaceCredential(embeddingCredentialProvider(provider)),
    catch: (cause) =>
      new EmbeddingSettingsFailed({
        message: 'Could not read the embedding keys',
        cause,
      }),
  })

export const getEmbeddingSettingsProgram = Effect.fn('getEmbeddingSettings')(
  function* (): Effect.fn.Return<
    EmbeddingSettingsView,
    EmbeddingSettingsFailed
  > {
    const pin = yield* readEmbeddingPinProgram().pipe(
      Effect.mapError(
        (e) =>
          new EmbeddingSettingsFailed({
            message: 'Could not read the embedding pin',
            cause: e.cause,
          }),
      ),
    )
    const keys: EmbeddingKeyRow[] = []
    for (const provider of EMBEDDING_PROVIDERS) {
      const row = yield* readKey(provider)
      const meta = row ? readProviderMeta(row.meta) : null
      keys.push({
        provider,
        label: EMBEDDING_PROVIDER_INFO[provider].label,
        configured: row !== undefined && row.status === 'active',
        display: meta?.display ?? null,
        lastTestedAt: meta?.lastTestedAt ?? null,
        lastTestOk: meta?.lastTestOk ?? null,
      })
    }
    return { pin, keys }
  },
)

export const saveEmbeddingKeyProgram = Effect.fn('saveEmbeddingKey')(function* (
  actorId: string,
  data: EmbeddingKeyInput,
): Effect.fn.Return<{ display: string }, EmbeddingSettingsFailed> {
  const display = redact(data.key)
  yield* Effect.tryPromise({
    try: () =>
      storeCredential({
        scope: 'workspace',
        provider: embeddingCredentialProvider(data.provider),
        kind: 'embedding',
        secret: data.key,
        meta: { display },
        createdBy: actorId,
      }),
    catch: (cause) =>
      new EmbeddingSettingsFailed({ message: 'Could not save the key', cause }),
  })
  return { display }
})

/** The word the Test call embeds. */
export const EMBED_TEST_TEXT = 'Spaces'

/**
 * Embeds `"Spaces"` with one model through the saved key, at the pin's
 * width, and answers the width, the first four values and the model id. It
 * runs through `embed()`, so the width is asserted and a completed test
 * writes one `ai_usage` row with the admin as caller. It never fails: a
 * refusal is the answer the admin asked for. A greyed model is refused
 * before any call — it cannot emit the width, and asking would spend tokens
 * to learn what the catalogue already says.
 */
export const testEmbeddingProgram = Effect.fn('testEmbedding')(function* (
  actorId: string,
  target: EmbeddingTarget,
): Effect.fn.Return<EmbeddingTestResult, EmbeddingSettingsFailed> {
  const label = EMBEDDING_PROVIDER_INFO[target.provider].label
  const model = findEmbeddingModel(target.provider, target.model)
  if (!model)
    return {
      ok: false,
      status: null,
      message: `${label} ${target.model} is not an embedding model this version knows`,
    }
  if (!model.emitsPin)
    return { ok: false, status: null, message: needsRepinNote(model) }

  const result = yield* embedProgram([EMBED_TEST_TEXT], {
    caller: { type: 'user', id: actorId },
    // An admin checking a key, not record bytes: nothing to resolve (SPA-61).
    sensitivity: 'normal',
    target,
    maxRetries: 0,
  }).pipe(
    Effect.map((r): EmbeddingTestResult => ({
      ok: true,
      model: r.target.model,
      width: r.vectors[0]?.length ?? 0,
      head: (r.vectors[0] ?? []).slice(0, 4),
    })),
    Effect.catch((error) =>
      Effect.succeed<EmbeddingTestResult>(
        error._tag === 'ProviderCallFailed'
          ? { ok: false, ...providerFailure(error.cause) }
          : { ok: false, status: null, message: embedMessage(error) },
      ),
    ),
  )

  const key = yield* readKey(target.provider)
  if (key)
    yield* Effect.tryPromise({
      try: () =>
        mergeCredentialMeta(key.id, {
          lastTestedAt: new Date().toISOString(),
          lastTestOk: result.ok,
        }),
      catch: (cause) =>
        new EmbeddingSettingsFailed({
          message: 'Could not record the test',
          cause,
        }),
    })
  return result
})

// The server fns' bodies. `requireAdmin()` first, always.

export async function getEmbeddingSettingsHandler(): Promise<EmbeddingSettingsView> {
  await requireAdmin()
  return effectFn(getEmbeddingSettingsProgram)()
}

export async function saveEmbeddingKeyHandler(
  data: EmbeddingKeyInput,
): Promise<{ display: string }> {
  const admin = await requireAdmin()
  return effectFn(saveEmbeddingKeyProgram)(admin.id, data)
}

export async function testEmbeddingHandler(
  data: EmbeddingTarget,
): Promise<EmbeddingTestResult> {
  const admin = await requireAdmin()
  return effectFn(testEmbeddingProgram)(admin.id, data)
}

/**
 * Pins, or refuses: `PinLocked` and `PinRefused` carry the sentence the
 * section shows as their `message`, so the rejection reaches the admin
 * whole. A read failure is given one here, since its tag carries none.
 */
export async function pinEmbeddingHandler(
  data: EmbeddingTarget,
): Promise<EmbeddingPinView> {
  await requireAdmin()
  return effectFn((target: EmbeddingTarget) =>
    pinEmbeddingProgram(target).pipe(
      Effect.catchTag('EmbeddingPinReadFailed', (e) =>
        Effect.fail(
          new EmbeddingSettingsFailed({
            message: 'Could not read the embedding pin',
            cause: e.cause,
          }),
        ),
      ),
    ),
  )(data)
}
