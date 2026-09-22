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
 * a `RetryError` wraps the last attempt's error. A request that never reached
 * a provider — a refused connection, DNS, a TLS failure at a wrong base URL —
 * is its own answer: the URL it tried and the transport's words
 * (`connect ECONNREFUSED 127.0.0.1:11434`), because "the provider refused"
 * would send the admin looking at the key when the address is what is wrong.
 */
export function providerFailure(error: unknown): {
  status: number | null
  message: string
} {
  const inner = RetryError.isInstance(error) ? error.lastError : error
  if (APICallError.isInstance(inner)) {
    // The SDK builds an APICallError with no status code only when fetch
    // itself threw — nothing came back to have a status.
    if (inner.statusCode === undefined)
      return {
        status: null,
        message: `Could not reach ${inner.url}: ${transportText(inner.cause) ?? inner.message}`,
      }
    return {
      status: inner.statusCode,
      // `data` is set only when the SDK parsed the provider's error body; when
      // it could not (Ollama answers `{"error": "model … not found"}`, a
      // string where the schema wants an object) its message is the bare
      // status text, and the body says more.
      message:
        (inner.data === undefined ? bodyMessage(inner.responseBody) : null) ||
        inner.message ||
        inner.responseBody ||
        'The provider refused',
    }
  }
  const transport = transportText(inner)
  if (transport) return { status: null, message: transport }
  if (inner instanceof Error) return { status: null, message: inner.message }
  return { status: null, message: String(inner) }
}

/** An error body's own words: `error`, `error.message` or `message`. */
function bodyMessage(body: string | undefined): string | null {
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null
      ? Reflect.get(value, key)
      : undefined
  const error = field(parsed, 'error')
  for (const candidate of [
    error,
    field(error, 'message'),
    field(parsed, 'message'),
  ])
    if (typeof candidate === 'string' && candidate) return candidate
  return null
}

/**
 * The innermost error on a cause chain that carries a system error code
 * (`ECONNREFUSED`, `ENOTFOUND`, undici's `UND_ERR_*`) — Node's fetch throws a
 * bare `TypeError: fetch failed` and hides the reason one `cause` down.
 */
function transportText(error: unknown): string | null {
  let found: string | null = null
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    const code: unknown = Reflect.get(current, 'code')
    if (typeof code === 'string')
      found = current.message.includes(code)
        ? current.message
        : `${code}: ${current.message}`
    current = current.cause
  }
  return found
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
