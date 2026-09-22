import { Effect } from 'effect'
import { APICallError, RetryError, generateText } from 'ai'
import type { LanguageModel } from 'ai'

/**
 * The settings Test call: one tiny prompt through a constructed model. It
 * never fails — a refusal from the provider is the answer the admin asked
 * for, so it comes back as `{ok: false, message}` carrying the provider's own
 * words (a wrong key reads `invalid x-api-key`, not "something went wrong").
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

export const runTestCall = Effect.fn('runTestCall')(function* (
  model: LanguageModel,
): Effect.fn.Return<TestCallResult> {
  return yield* Effect.tryPromise({
    try: () =>
      generateText({
        model,
        prompt: TEST_PROMPT,
        maxOutputTokens: 1024,
        // One attempt: a 401 is not retryable anyway, and a Test button that
        // quietly retries a 529 three times reads as a hang.
        maxRetries: 0,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.map((r): TestCallResult => ({ ok: true, text: r.text })),
    Effect.catch((error) =>
      Effect.succeed<TestCallResult>({ ok: false, ...providerFailure(error) }),
    ),
  )
})
