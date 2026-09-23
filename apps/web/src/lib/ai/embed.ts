import { Effect, Schema } from 'effect'
import type { EmbeddingModel } from 'ai'
import { db } from '@spaces/db'
import { aiUsage } from '@spaces/db/schema'
import { SensitiveRouteRefused, UsageWriteFailed } from './complete'
import type { Caller, ProviderCallFailed } from './complete'
import { capMessage, checkCapProgram } from './caps'
import type { CapExceeded, CapReadFailed } from './caps'
import { readEmbeddingPinProgram } from './embedding-pin'
import type { EmbeddingPinReadFailed } from './embedding-pin'
import type { AiSensitivity } from './lanes'
import type { SensitivityVia } from './sensitivity'
import type { ResolveModelFailure } from './providers'
import { resolveEmbedCall } from './providers/embed'
import { sdkDimensionOptions, sdkEmbedCall } from './providers/embed/adapter'
import { EMBEDDING_PROVIDER_INFO, PIN_DIMS } from './providers/embed/ids'
import type { EmbeddingTarget } from './providers/embed/ids'

/**
 * `embed(texts, {sensitivity, caller})` — the other half of the provider
 * contract (`docs/spec-ai-substrate.md` §4, §9; SPA-51). It reads the
 * workspace's embedding pin (none → `EmbeddingNotPinned`), refuses a
 * `sensitive` call to a cloud embedder, checks the AI cap, resolves the
 * `kind: 'embedding'` credential, calls the model once, writes one
 * `ai_usage` row for what the provider billed, and asserts that **every**
 * vector is exactly the pin's width — one wrong-width vector fails the whole
 * call `DimensionMismatch` and no vector is returned to be stored. The usage
 * row is written either way: the tokens were spent, and the cap counts
 * them. A vector of the wrong width in `chunk.embedding` is not an error
 * Postgres would always raise; it is the dimension trap, and this is where
 * it is sprung.
 *
 * The signature carries `sensitivity` although only one branch of it is
 * reachable (D11): today every embedding provider is cloud, so a `sensitive`
 * call is always refused `SensitiveRouteRefused` and the record is left
 * unembedded — skip, never leak (`./sensitivity.ts`). The branch becomes
 * reachable for a sensitive record only once SPA-83 adds the local slot (a
 * same-width local model); that is additive, not a change to every caller.
 *
 * `opts.model` is the test seam, as `complete()`'s is: an injected AI SDK
 * `EmbeddingModel` (`MockEmbeddingModelV4` from `ai/test`) replaces the vault
 * lookup and the transport. The pin is still read and every check still
 * applies — the seam replaces the wire, not the policy. `opts.target`
 * replaces the pin with an explicit model; only the settings Test call, which
 * tests a model before it is pinned, uses it.
 */

export type EmbedOptions = {
  caller: Caller
  sensitivity: AiSensitivity
  /** Which input made it sensitive — `sensitivityFor`'s answer, carried to the refusal. */
  via?: SensitivityVia
  model?: EmbeddingModel
  target?: EmbeddingTarget
  jobRunId?: string
  maxRetries?: number
}

export type EmbedResult = {
  /** One per text, in order, each exactly `target.dims` long. */
  vectors: Array<Array<number>>
  target: EmbeddingTarget & { dims: number }
  usage: { tokens: number | null }
}

/** No embedding model is pinned: the workspace has no vectors, by choice. */
export class EmbeddingNotPinned extends Schema.TaggedError<EmbeddingNotPinned>()(
  'EmbeddingNotPinned',
  {},
) {}

/** The provider answered with a vector that is not the pin's width. */
export class DimensionMismatch extends Schema.TaggedError<DimensionMismatch>()(
  'DimensionMismatch',
  {
    provider: Schema.String,
    model: Schema.String,
    expected: Schema.Number,
    received: Schema.Number,
  },
) {}

/** The provider answered with a different number of vectors than texts sent. */
export class EmbeddingCountMismatch extends Schema.TaggedError<EmbeddingCountMismatch>()(
  'EmbeddingCountMismatch',
  { provider: Schema.String, expected: Schema.Number, received: Schema.Number },
) {}

export type EmbedFailure =
  | EmbeddingNotPinned
  | EmbeddingPinReadFailed
  | SensitiveRouteRefused
  | CapExceeded
  | CapReadFailed
  | ResolveModelFailure
  | ProviderCallFailed
  | DimensionMismatch
  | EmbeddingCountMismatch
  | UsageWriteFailed

const label = (provider: string): string =>
  Object.entries(EMBEDDING_PROVIDER_INFO).find(([id]) => id === provider)?.[1]
    .label ?? provider

/** The sentence a caller is shown; these tagged errors carry no `message`. */
export function embedMessage(failure: EmbedFailure): string {
  switch (failure._tag) {
    case 'EmbeddingNotPinned':
      return 'No embedding model is pinned'
    case 'EmbeddingPinReadFailed':
      return 'Could not read the embedding pin'
    case 'SensitiveRouteRefused':
      return `Sensitive material is not sent to ${label(failure.provider)} for embedding; it is left unembedded until a local embedding model is set up`
    case 'CapExceeded':
      return capMessage(failure)
    case 'CapReadFailed':
      return 'Could not read the AI cap'
    case 'NoCredential':
      return `No ${label(failure.provider)} embedding key is saved`
    case 'CredentialReadFailed':
      return 'Could not read the credential'
    case 'ProviderCallFailed':
      return `${label(failure.provider)} did not answer`
    case 'DimensionMismatch':
      return `${label(failure.provider)} ${failure.model} returned ${failure.received} dimensions; this workspace stores ${failure.expected}`
    case 'EmbeddingCountMismatch':
      return `${label(failure.provider)} returned ${failure.received} vectors for ${failure.expected} texts`
    case 'UsageWriteFailed':
      return 'Could not record the AI usage'
  }
}

export const embedProgram = Effect.fn('embed')(function* (
  texts: ReadonlyArray<string>,
  opts: EmbedOptions,
): Effect.fn.Return<EmbedResult, EmbedFailure> {
  const pinned = opts.target ? null : yield* readEmbeddingPinProgram()
  const target = opts.target
    ? { ...opts.target, dims: PIN_DIMS }
    : pinned
      ? { provider: pinned.provider, model: pinned.model, dims: pinned.dims }
      : null
  if (target === null) return yield* new EmbeddingNotPinned()

  // No local embedding provider exists until SPA-83, so this refuses every
  // sensitive call today. There is no cloud fallback, by construction.
  if (
    opts.sensitivity === 'sensitive' &&
    !EMBEDDING_PROVIDER_INFO[target.provider].local
  )
    return yield* new SensitiveRouteRefused({
      lane: 'embed',
      provider: target.provider,
      ...(opts.via === undefined ? {} : { via: opts.via }),
    })

  if (texts.length === 0) return { vectors: [], target, usage: { tokens: 0 } }

  yield* checkCapProgram(texts.reduce((n, t) => n + t.length, 0))

  const call = opts.model
    ? sdkEmbedCall(
        target.provider,
        opts.model,
        sdkDimensionOptions(target.provider, target.dims),
        opts.maxRetries,
      )
    : (yield* resolveEmbedCall(target.provider, {
        modelId: target.model,
        dims: target.dims,
        ...(opts.caller.type === 'user' ? { userId: opts.caller.id } : {}),
      })).call

  const answer = yield* call(texts)

  // The provider has answered, so it has billed: the usage row is written
  // before the answer is judged, and a call refused below still counts
  // against the day's cap.
  yield* Effect.tryPromise({
    try: () =>
      db.insert(aiUsage).values({
        lane: 'embed',
        provider: target.provider,
        model: target.model,
        tokensIn: answer.tokens,
        tokensOut: null,
        callerType: opts.caller.type,
        callerId: opts.caller.type === 'system' ? null : opts.caller.id,
        jobRunId: opts.jobRunId ?? null,
      }),
    catch: (cause) => new UsageWriteFailed({ cause }),
  })

  if (answer.embeddings.length !== texts.length)
    return yield* new EmbeddingCountMismatch({
      provider: target.provider,
      expected: texts.length,
      received: answer.embeddings.length,
    })
  const wrong = answer.embeddings.find((v) => v.length !== target.dims)
  if (wrong)
    return yield* new DimensionMismatch({
      provider: target.provider,
      model: target.model,
      expected: target.dims,
      received: wrong.length,
    })

  return {
    vectors: answer.embeddings,
    target,
    usage: { tokens: answer.tokens },
  }
})
