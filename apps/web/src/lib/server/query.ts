import { Effect, Schema } from 'effect'

/**
 * A failed read or write in a server module. One class for every module in
 * this directory, so a reader learns one name.
 * - `message` is the cause's own, so a caller that prints a rejected call's
 *   message reads what it read before the call was a program.
 */
export class ServerQueryFailed extends Schema.TaggedError<ServerQueryFailed>()(
  'ServerQueryFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The failure for a thrown cause, `prefix` leading its message when given. */
export const serverQueryFailed = (cause: unknown, prefix?: string) => {
  const said = cause instanceof Error ? cause.message : String(cause)
  return new ServerQueryFailed({
    cause,
    message: prefix === undefined ? said : `${prefix}: ${said}`,
  })
}

/** A database call inside a server module's program. */
export const serverQuery = <T>(run: () => Promise<T>, prefix?: string) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => serverQueryFailed(cause, prefix),
  })
