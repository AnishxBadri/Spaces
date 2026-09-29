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
import { renderPrompt } from './prompt'
import { aiRouteProgram, isLocalProvider } from './route'
import { capMessage, checkCapProgram } from './caps'
import type { CapExceeded, CapReadFailed } from './caps'
import type { AiTarget, LaneNotRouted, RouteReadFailed } from './route'
import type { AiLane, AiSensitivity } from './lanes'
import type { SensitivityVia } from './sensitivity'
import type { RunWriteFailed } from './run'

/**
 * `complete(lane, items, schema?, opts)` — half of the provider contract
 * (docs/spec-ai-substrate.md §4, §9). A feature names a lane and hands over
 * ranked `ContextItem`s; this resolves the lane to a provider and model,
 * refuses a sensitive call to the cloud, renders the items as `[ref] text`
 * blocks (`./prompt.ts`) so the output can cite, calls the model once, and
 * writes one `ai_usage` row for the completed call.
 *
 * Sensitivity is an **input**: the caller supplies it, from
 * `sensitivityFor(subject)` (`./sensitivity-for.ts`, SPA-61), spreading its
 * `{sensitivity, via}` into the options so a refusal can name the space the
 * record inherited from.
 * A `sensitive` call whose target is not a local provider fails
 * `SensitiveRouteRefused` — there is no fallback to cloud, by construction:
 * the check runs against the one target this call has, after it is chosen
 * and before any model is built.
 *
 * The workspace AI cap (SPA-73, `./caps.ts`) is checked next, before any
 * model is built or called: a day whose tokens are at the ceiling, or a call
 * whose `budgetChars` estimate is over the per-run cap, fails `CapExceeded`.
 * The check is per call, never mid-stream — a call already in flight when
 * the ceiling is crossed completes and writes its `ai_usage` row.
 *
 * `opts.model` is the test seam every AI test uses: an injected AI SDK
 * `LanguageModel` (`MockLanguageModelV4` from `ai/test`) replaces the vault
 * lookup, so no test reaches a network. The route is still read, and the
 * sensitivity check still applies — the seam replaces the transport, not the
 * policy. `opts.route` replaces the table lookup with an explicit target:
 * the settings Test call, which tests one provider, and the extraction cache,
 * which has already read the route to key on its model and hands the same
 * target on so the model it keyed is the model called.
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
  /** The rendered prompt's ceiling, task included (`renderPrompt`). */
  budgetChars: number
  /** What to do with the context — rendered after it. */
  task: string
  model?: LanguageModel
  route?: AiTarget
  jobRunId?: string
  /**
   * The run this call is a step of (`./run.ts`, SPA-100) — written to
   * `ai_usage.run_id`. Absent, the call is outside any run: the settings Test
   * call.
   */
  runId?: string
  maxOutputTokens?: number
  maxRetries?: number
  /**
   * Files sent beside the rendered prompt, as `file` parts of the one user
   * message (SPA-94: the vision lane hands a PDF page range to the provider,
   * which renders the pages itself). Absent or empty, the call is the plain
   * `prompt` string it always was. The cap estimate is still `budgetChars`:
   * a caller sending files sizes it for what the files will cost.
   */
  files?: ReadonlyArray<CompleteFile>
}

/** One file part of a `complete()` call. PDF only, until a lane needs more. */
export type CompleteFile = {
  mediaType: 'application/pdf'
  data: Uint8Array
  name?: string
}

export type CompleteOutput =
  | { kind: 'text'; text: string }
  /** Parsed against the schema by the SDK; the caller validates it again. */
  | { kind: 'object'; object: unknown }

export type CompleteResult = {
  output: CompleteOutput
  target: AiTarget
  usage: { tokensIn: number | null; tokensOut: number | null }
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
  // Not raised here: a feature's run-log write (`./run.ts`). Named in this
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

const tokens = (usage: LanguageModelUsage) => ({
  tokensIn: usage.inputTokens ?? null,
  tokensOut: usage.outputTokens ?? null,
})

/**
 * The one target a call to `lane` at this sensitivity goes to, with the
 * sensitive-to-cloud refusal already applied — the policy half of
 * `complete()`, before any cap, model or prompt. Exported for the extraction
 * cache (`./extraction-cache.ts`, SPA-74), which must key on the routed model
 * before deciding whether to call, and must refuse a sensitive read to the
 * cloud even when the answer is already on disk.
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

  const prompt = renderPrompt({
    items,
    task: opts.task,
    budgetChars: opts.budgetChars,
  })
  // With files, the prompt becomes the text part of one user message and each
  // file a `file` part after it; without, the call is unchanged.
  const input =
    opts.files === undefined || opts.files.length === 0
      ? { prompt }
      : {
          messages: [
            {
              role: 'user' as const,
              content: [
                { type: 'text' as const, text: prompt },
                ...opts.files.map((f) => ({
                  type: 'file' as const,
                  data: f.data,
                  mediaType: f.mediaType,
                  ...(f.name === undefined ? {} : { filename: f.name }),
                })),
              ],
            },
          ],
        }
  const settings = {
    model,
    ...input,
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
          usage: tokens(r.usage),
        }
      }
      const r = await generateText(settings)
      return { output: { kind: 'text', text: r.text }, usage: tokens(r.usage) }
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

  return { ...answered, target, credentialId: resolved.credentialId }
})
