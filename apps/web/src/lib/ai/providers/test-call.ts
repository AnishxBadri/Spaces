import { Effect } from 'effect'
import { APICallError, RetryError } from 'ai'
import type { LanguageModel } from 'ai'
import { completeMessage, completeProgram, modelIdOf } from '../complete'
import type { Caller } from '../complete'
import type { AiLane } from '../lanes'
import type { LlmProvider } from './ids'

/**
 * The settings Test call: one tiny prompt through a constructed model. It
 * never fails — a refusal from the provider is the answer the admin asked
 * for, so it comes back as `{ok: false, message}` carrying the provider's own
 * words (a wrong key reads `invalid x-api-key`, not "something went wrong").
 *
 * It runs through `complete()` (SPA-42) like every model call, so a completed
 * test writes its one `ai_usage` row, recorded under `via.lane` and the
 * caller who pressed the button. The model is handed in already built — the
 * Test call tests one provider's saved key, not the routing grid.
 */

export const TEST_PROMPT = 'Reply with the single word OK.'

export type TestCallResult =
  | { ok: true; text: string }
  | { ok: false; status: number | null; message: string }

/**
 * What the provider said. An `APICallError` carries the provider's parsed
 * error message (Anthropic's `error.message`) and falls back to the raw body;
 * a `RetryError` wraps the last attempt's error; anything else — DNS, a
 * refused connection to a wrong base URL — says what it is.
 */
export function providerFailure(error: unknown): {
  status: number | null
  message: string
} {
  const inner = RetryError.isInstance(error) ? error.lastError : error
  if (APICallError.isInstance(inner)) {
    return {
      status: inner.statusCode ?? null,
      message: inner.message || inner.responseBody || 'The provider refused',
    }
  }
  if (inner instanceof Error) return { status: null, message: inner.message }
  return { status: null, message: String(inner) }
}

export type TestCallVia = {
  provider: LlmProvider
  lane: AiLane
  caller: Caller
}

export const runTestCall = Effect.fn('runTestCall')(function* (
  model: LanguageModel,
  via: TestCallVia,
): Effect.fn.Return<TestCallResult> {
  return yield* completeProgram(via.lane, [], undefined, {
    caller: via.caller,
    sensitivity: 'normal',
    budgetChars: 1000,
    task: TEST_PROMPT,
    model,
    route: { provider: via.provider, model: modelIdOf(model) },
    maxOutputTokens: 1024,
    // One attempt: a 401 is not retryable anyway, and a Test button that
    // quietly retries a 529 three times reads as a hang.
    maxRetries: 0,
  }).pipe(
    Effect.map((r): TestCallResult =>
      r.output.kind === 'text'
        ? { ok: true, text: r.output.text }
        : { ok: true, text: JSON.stringify(r.output.object) },
    ),
    Effect.catch((error) =>
      Effect.succeed<TestCallResult>(
        error._tag === 'ProviderCallFailed'
          ? { ok: false, ...providerFailure(error.cause) }
          : { ok: false, status: null, message: completeMessage(error) },
      ),
    ),
  )
})
