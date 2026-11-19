import type { execValidator } from '@tanstack/react-start'

/**
 * A server fn's own validator, reachable from a test. An uncompiled server
 * fn keeps its validator out of reach, so a test file stands in a
 * `createServerFn` that records each validator against the fn it builds:
 *
 * ```ts
 * vi.mock('@tanstack/react-start', async (actual) =>
 *   (await import('#/test/server-fn-validators')).capturingStart(
 *     await actual(),
 *   ),
 * )
 * ```
 *
 * then `validate(mod.someFn, value)` runs that fn's validator through
 * Start's own `execValidator`, as the server does before its handler.
 * Module state, scoped to the file it is mocked into. Imports Start as a
 * type only: a value import here would wait on the mock it is building.
 */

type Exec = typeof execValidator
type Validator = Parameters<Exec>[0]

const captured = new Map<unknown, Validator>()
let exec: Exec | null = null

type Builder = {
  middleware: () => Builder
  validator: (validator: Validator) => Builder
  inputValidator: (validator: Validator) => Builder
  handler: () => () => never
}

const builder = (validator: Validator | null): Builder => ({
  middleware: () => builder(validator),
  validator: (next) => builder(next),
  inputValidator: (next) => builder(next),
  handler: () => {
    const fn = (): never => {
      throw new Error('a captured server fn is never called')
    }
    if (validator !== null) captured.set(fn, validator)
    return fn
  },
})

/** `@tanstack/react-start` with a recording `createServerFn`. */
export const capturingStart = <T extends { execValidator: Exec }>(
  actual: T,
) => {
  exec = actual.execValidator
  return { ...actual, createServerFn: () => builder(null) }
}

/** The fn's validator, run as the server runs it; throws a missing capture at once. */
const runner = (fn: unknown) => {
  const validator = captured.get(fn)
  if (validator === undefined || exec === null)
    throw new Error('no validator was captured for this server fn')
  const run = exec
  return (value: unknown): Promise<unknown> => run(validator, value)
}

/** What the server fn's validator hands its handler; rejects when it refuses. */
export const validate = (fn: unknown, value: unknown): Promise<unknown> =>
  runner(fn)(value)

/** A refused input, as a table row reads it. */
export const REFUSED = 'REFUSED'

/**
 * The verdict as a table row reads it: the handler's input, or `REFUSED`.
 * A fn with no captured validator throws rather than reading as a refusal.
 */
export const verdict = async (fn: unknown, value: unknown) => {
  const run = runner(fn)
  try {
    return await run(value)
  } catch {
    return REFUSED
  }
}
