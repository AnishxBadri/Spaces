import { Effect, Schema } from 'effect'
import { Output, generateText, jsonSchema } from 'ai'
import type { LanguageModel, LanguageModelUsage } from 'ai'
import { db } from '@spaces/db'
import { aiUsage } from '@spaces/db/schema'
import type { JsonSchema } from '@spaces/core/ai/schema'
import type { ContextItem } from '@spaces/core/context/types'
import { resolveLanguageModel } from './providers'
import type { ResolveModelFailure } from './providers'
import { PROVIDER_LABEL } from './providers/ids'
import { buildRequest } from './prompt'
import type { PromptFile } from './prompt'
import { aiRouteProgram, isLocalProvider } from './route'
import { capMessage, checkCapProgram } from './caps'
import type { CapExceeded, CapReadFailed } from './caps'
import type { AiTarget, LaneNotRouted, RouteReadFailed } from './route'
import type { AiLane, AiSensitivity } from './lanes'
import type { SensitivityVia } from './sensitivity'
import type { RunWriteFailed } from './run'

/**
 * `complete(lane, items, schema?, opts)`: resolves the lane to a provider and
 * model, sends the lane's instructions as the system part and the ranked
 * `ContextItem`s (citable `[ref] text` blocks) then the subject as the user
 * part, calls the model once and writes one `ai_usage` row.
 * - Sensitivity is an input (from `sensitivityFor`). A `sensitive` call to a
 *   non-local target fails `SensitiveRouteRefused`, checked before any model
 *   is built; there is no fallback to cloud.
 * - The cap is checked next (`CapExceeded`), per call, never mid-stream.
 * - `opts.model` is the test seam (no network); route and sensitivity still
 *   apply. `opts.route` pins the target (the Test call, the extraction cache).
 */

/** Who asked. The same typed actor as `attribute_event` / `suggestion`. */
export type Caller =
  | { type: 'user'; id: string }
  | { type: 'integration'; id: string }
  | { type: 'system' }

export type CompleteOptions = {
  caller: Caller
  sensitivity: AiSensitivity
  /** Which input made it sensitive — `sensitivityFor`'s answer, carried to the refusal. */
  via?: SensitivityVia
  /** The whole request's ceiling, system part and subject included (`buildRequest`). */
  budgetChars: number
  /**
   * The lane's fixed text, sent as the system part: identical on every call
   * of the lane, so a provider can cache it. Nothing per-call belongs here.
   */
  instructions: string
  /** What this call is about (the row, the document's name), rendered after the context. */
  subject?: string
  model?: LanguageModel
  route?: AiTarget
  jobRunId?: string
  /**
   * The run this call is a step of, written to `ai_usage.run_id`. Absent, the
   * call is outside any run (the settings Test call).
   */
  runId?: string
  maxOutputTokens?: number
  maxRetries?: number
  /**
   * Files sent as `file` parts after the user part's text (the vision lane's
   * PDF page range). The cap estimate is still `budgetChars`, so a caller
   * sending files sizes it for them.
   */
  files?: ReadonlyArray<PromptFile>
}

export type CompleteOutput =
  | { kind: 'text'; text: string }
  /** Parsed against the schema by the SDK; the caller validates it again. */
  | { kind: 'object'; object: unknown }

/** What the provider reported; `tokensCached` is null where it reports no cache reads. */
export type CompleteUsage = {
  tokensIn: number | null
  tokensOut: number | null
  tokensCached: number | null
}

export type CompleteResult = {
  output: CompleteOutput
  target: AiTarget
  usage: CompleteUsage
  /** The vault key the call resolved; null for an injected test model. */
  credentialId: string | null
}

/** A `sensitive` call routed to a provider that is not local. */
export class SensitiveRouteRefused extends Schema.TaggedError<SensitiveRouteRefused>()(
  'SensitiveRouteRefused',
  {
    lane: Schema.String,
    provider: Schema.String,
    via: Schema.optionalKey(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal('own') }),
        Schema.Struct({ kind: Schema.Literal('space'), name: Schema.String }),
        Schema.Struct({
          kind: Schema.Literal('binding'),
          name: Schema.optionalKey(Schema.String),
        }),
        Schema.Struct({ kind: Schema.Literal('default') }),
      ]),
    ),
  },
) {}

/** Where a refusal's sensitivity came from, as the tail of its sentence. */
const viaClause = (via: SensitivityVia | undefined): string => {
  if (via === undefined) return ''
  switch (via.kind) {
    case 'own':
      return ''
    case 'space':
      return ` (sensitivity inherited from ${via.name})`
    case 'binding':
      return ` (sensitivity inherited from ${via.name ?? 'its storage binding'})`
    case 'default':
      return ' (the workspace default is sensitive)'
  }
}

/**
 * The provider answered with an error, or could not be reached. `cause` is
 * the SDK's own error, kept whole so a caller that wants the provider's words
 * (the Test call, via `providerFailure`) can read them; `completeMessage`
 * never shows it.
 */
export class ProviderCallFailed extends Schema.TaggedError<ProviderCallFailed>()(
  'ProviderCallFailed',
  { provider: Schema.String, cause: Schema.Defect() },
) {}

export class UsageWriteFailed extends Schema.TaggedError<UsageWriteFailed>()(
  'UsageWriteFailed',
  { cause: Schema.Defect() },
) {}

export type CompleteFailure =
  | LaneNotRouted
  | RouteReadFailed
  | SensitiveRouteRefused
  | ResolveModelFailure
  | ProviderCallFailed
  | UsageWriteFailed
  | CapExceeded
  | CapReadFailed
  // Not raised here: a feature's run-log write. Named in this
  // union so every feature's message, which falls through to
  // `completeMessage`, already has a sentence for it.
  | RunWriteFailed

const providerLabel = (provider: string): string =>
  Object.entries(PROVIDER_LABEL).find(([id]) => id === provider)?.[1] ??
  provider

/**
 * The sentence a caller is shown. Tagged errors here carry no `message`, so
 * `Effect.runPromise`'s rejection would otherwise reach a toast empty.
 */
export function completeMessage(failure: CompleteFailure): string {
  switch (failure._tag) {
    case 'LaneNotRouted':
      return `No model is routed for the ${failure.lane} lane${failure.sensitivity === 'sensitive' ? ' at sensitive scope' : ''}`
    case 'SensitiveRouteRefused':
      return `Sensitive material is not sent to ${providerLabel(failure.provider)}${viaClause(failure.via)}; route the ${failure.lane} lane to a local model`
    case 'NoCredential':
      return `No ${providerLabel(failure.provider)} key is saved`
    case 'ProviderCallFailed':
      return `${providerLabel(failure.provider)} did not answer`
    case 'RouteReadFailed':
      return 'Could not read the AI routing'
    case 'CredentialReadFailed':
      return 'Could not read the credential'
    case 'UsageWriteFailed':
      return 'Could not record the AI usage'
    case 'CapExceeded':
      return capMessage(failure)
    case 'CapReadFailed':
      return 'Could not read the AI cap'
    case 'RunWriteFailed':
      return 'Could not record the AI run'
  }
}

/** The model id a `LanguageModel` names — a gateway string is its own id. */
export function modelIdOf(model: LanguageModel): string {
  return typeof model === 'string' ? model : model.modelId
}

export const usageOf = (usage: LanguageModelUsage): CompleteUsage => ({
  tokensIn: usage.inputTokens ?? null,
  tokensOut: usage.outputTokens ?? null,
  tokensCached: usage.inputTokenDetails.cacheReadTokens ?? null,
})

/** One call's usage as the log shows it, cache reads included. */
export const usageLine = (
  lane: AiLane,
  target: AiTarget,
  usage: CompleteUsage,
): string =>
  `ai usage ${lane} ${target.provider}/${target.model}: ${String(usage.tokensIn ?? '?')} in (${String(usage.tokensCached ?? '-')} cached) / ${String(usage.tokensOut ?? '?')} out`

/** Whether `provider` reads the cache markers `buildRequest` can set. */
export const readsCacheMarkers = (provider: string): boolean =>
  provider === 'anthropic'

/**
 * The one target a call to `lane` goes to, with the sensitive-to-cloud
 * refusal applied: the policy half of `complete()`. Exported for the
 * extraction cache, which keys on the routed model and must refuse a
 * sensitive read to the cloud even when the answer is already cached.
 */
export const laneTargetProgram = Effect.fn('laneTarget')(function* (
  lane: AiLane,
  opts: Pick<CompleteOptions, 'sensitivity' | 'via' | 'route'>,
): Effect.fn.Return<
  AiTarget,
  LaneNotRouted | RouteReadFailed | SensitiveRouteRefused
> {
  const target = opts.route ?? (yield* aiRouteProgram(lane, opts.sensitivity))
  if (opts.sensitivity === 'sensitive' && !isLocalProvider(target.provider))
    return yield* new SensitiveRouteRefused({
      lane,
      provider: target.provider,
      ...(opts.via === undefined ? {} : { via: opts.via }),
    })
  return target
})

export const completeProgram = Effect.fn('complete')(function* (
  lane: AiLane,
  items: ReadonlyArray<ContextItem>,
  schema: JsonSchema | undefined,
  opts: CompleteOptions,
): Effect.fn.Return<CompleteResult, CompleteFailure> {
  const target = yield* laneTargetProgram(lane, opts)

  // Before the model is built, let alone called. Per call, not mid-stream:
  // once this passes, the call runs to completion and is recorded below even
  // if its tokens carry the day past the ceiling — the next call refuses.
  yield* checkCapProgram(opts.budgetChars)

  const resolved =
    opts.model === undefined
      ? yield* resolveLanguageModel(target.provider, {
          modelId: target.model,
          ...(opts.caller.type === 'user' ? { userId: opts.caller.id } : {}),
        })
      : { model: opts.model, credentialId: null }
  const model = resolved.model

  const request = buildRequest({
    instructions: opts.instructions,
    items,
    subject: opts.subject ?? '',
    budgetChars: opts.budgetChars,
    cache: readsCacheMarkers(target.provider),
    ...(opts.files === undefined ? {} : { files: opts.files }),
  })
  const settings = {
    model,
    ...request,
    ...(opts.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: opts.maxOutputTokens }),
    ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
  }

  const answered = yield* Effect.tryPromise({
    try: async (): Promise<Omit<CompleteResult, 'target' | 'credentialId'>> => {
      if (schema) {
        const r = await generateText({
          ...settings,
          output: Output.object({ schema: jsonSchema<unknown>(schema) }),
        })
        return {
          output: { kind: 'object', object: r.output },
          usage: usageOf(r.usage),
        }
      }
      const r = await generateText(settings)
      return { output: { kind: 'text', text: r.text }, usage: usageOf(r.usage) }
    },
    catch: (cause) =>
      new ProviderCallFailed({ provider: target.provider, cause }),
  })

  yield* Effect.tryPromise({
    try: () =>
      db.insert(aiUsage).values({
        lane,
        provider: target.provider,
        model: target.model,
        tokensIn: answered.usage.tokensIn,
        tokensOut: answered.usage.tokensOut,
        callerType: opts.caller.type,
        callerId: opts.caller.type === 'system' ? null : opts.caller.id,
        jobRunId: opts.jobRunId ?? null,
        runId: opts.runId ?? null,
      }),
    catch: (cause) => new UsageWriteFailed({ cause }),
  })
  // The cached count is not stored yet; the log line is where a cache hit shows.
  yield* Effect.log(usageLine(lane, target, answered.usage))

  return { ...answered, target, credentialId: resolved.credentialId }
})
