import { Effect, Schema } from 'effect'
import type { EmbeddingModel } from 'ai'
import { db } from '@spaces/db'
import { aiUsage } from '@spaces/db/schema'
import { SensitiveRouteRefused, UsageWriteFailed } from './complete'
import type { Caller, ProviderCallFailed } from './complete'
import { capMessage, checkCapProgram } from './caps'
import type { CapExceeded, CapReadFailed } from './caps'
import { readEmbeddingSetupProgram } from './embedding-pin'
import type { EmbeddingPinReadFailed } from './embedding-pin'
import type { AiSensitivity } from './lanes'
import type { SensitivityVia } from './sensitivity'
import type { ResolveModelFailure } from './providers'
import { resolveEmbedCall } from './providers/embed'
import { sdkDimensionOptions, sdkEmbedCall } from './providers/embed/adapter'
import {
  EMBEDDING_PROVIDER_INFO,
  PIN_DIMS,
  isEmbeddingProvider,
} from './providers/embed/ids'
import type { EmbeddingTarget } from './providers/embed/ids'

/**
 * `embed(texts, {sensitivity, caller})`: reads the pin (none →
 * `EmbeddingNotPinned`), checks the AI cap, resolves the `kind: 'embedding'`
 * credential, calls the model once and writes one `ai_usage` row.
 * - Every vector must be exactly the pin's width; one wrong-width vector
 *   fails the call `DimensionMismatch` and nothing is returned to store. The
 *   usage row is written either way: the tokens were spent.
 * - A `sensitive` call goes to a local provider or nowhere: a local pin, else
 *   the sensitive slot, else `SensitiveRouteRefused` (skip, never leak).
 *   Never downgraded to a cloud pin.
 * - The answer names the target that made the vectors, so a caller stores
 *   the slot's model as `embedding_model` and the semantic lane skips them.
 * - `opts.model` is the test seam: it replaces the wire, not the policy.
 *   `opts.target` replaces the pin; only the settings Test call uses it.
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
      return isEmbeddingProvider(failure.provider) &&
        EMBEDDING_PROVIDER_INFO[failure.provider].keyless
        ? `No ${label(failure.provider)} address is saved`
        : `No ${label(failure.provider)} embedding key is saved`
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
  const setup = opts.target ? null : yield* readEmbeddingSetupProgram()
  const pinned = setup?.pin ?? null
  const pinTarget = opts.target
    ? { ...opts.target, dims: PIN_DIMS }
    : pinned
      ? { provider: pinned.provider, model: pinned.model, dims: pinned.dims }
      : null
  if (pinTarget === null) return yield* new EmbeddingNotPinned()

  // A sensitive call to a cloud pin goes to the local slot beside it, or is
  // refused. Never the pin: a sensitive call is never downgraded to the cloud.
  let target = pinTarget
  if (
    opts.sensitivity === 'sensitive' &&
    !EMBEDDING_PROVIDER_INFO[pinTarget.provider].local
  ) {
    const slot = setup?.slot ?? null
    if (slot === null)
      return yield* new SensitiveRouteRefused({
        lane: 'embed',
        provider: pinTarget.provider,
        ...(opts.via === undefined ? {} : { via: opts.via }),
      })
    target = { provider: slot.provider, model: slot.model, dims: slot.dims }
  }

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
        ...(opts.maxRetries === undefined
          ? {}
          : { maxRetries: opts.maxRetries }),
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
