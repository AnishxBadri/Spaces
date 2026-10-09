import { Effect, Layer } from 'effect'
import type { LanguageModel } from 'ai'
import { ModelCall, ModelCallRefused } from '@spaces/core/writes/ports/ai'
import type { ModelCallInput } from '@spaces/core/writes/ports/ai'
import { completeMessage, completeProgram } from '#web/lib/ai/complete'
import type { CompleteFailure } from '#web/lib/ai/complete'

/**
 * The `ModelCall` AiLive runs on: `complete()` with the plugin's caller and
 * the sensitivity core resolved. `model` is the test seam `complete()` takes
 * (an injected AI SDK model in place of the vault lookup); the route, the
 * sensitive-to-cloud refusal, the cap and the `ai_usage` row stay real.
 */

/** Whether running the job again could change the answer. */
const retryable = (failure: CompleteFailure): boolean => {
  switch (failure._tag) {
    case 'SensitiveRouteRefused':
    case 'CapExceeded':
    case 'LaneNotRouted':
    case 'NoCredential':
      return false
    case 'ProviderCallFailed':
    case 'RouteReadFailed':
    case 'CredentialReadFailed':
    case 'UsageWriteFailed':
    case 'CapReadFailed':
    case 'RunWriteFailed':
      return true
  }
}

export const ModelCallLive = (
  options: { readonly model?: LanguageModel } = {},
): Layer.Layer<ModelCall> =>
  Layer.succeed(
    ModelCall,
    ModelCall.of({
      complete: (input: ModelCallInput) =>
        completeProgram(input.lane, input.items, input.schema, {
          caller: input.caller,
          sensitivity: input.sensitivity.sensitivity,
          ...(input.sensitivity.sensitivity === 'sensitive'
            ? { via: input.sensitivity.via }
            : {}),
          budgetChars: input.budgetChars,
          task: input.task,
          ...(options.model === undefined ? {} : { model: options.model }),
        }).pipe(
          Effect.map((result) => result.output),
          Effect.mapError(
            (failure) =>
              new ModelCallRefused({
                tag: failure._tag,
                message: completeMessage(failure),
                retryable: retryable(failure),
              }),
          ),
        ),
    }),
  )
