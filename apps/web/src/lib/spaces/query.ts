import { Effect, Schema } from 'effect'

/**
 * A failed read or write in a spaces module. One class for the directory's
 * database calls, so a reader learns one name.
 * - `message` is the cause's own, so a caller that prints a rejected call's
 *   message reads what it read before the call was a program.
 */
export class SpacesQueryFailed extends Schema.TaggedError<SpacesQueryFailed>()(
  'SpacesQueryFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The failure for a thrown cause. */
const spacesQueryFailed = (cause: unknown) =>
  new SpacesQueryFailed({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })

/** A database call inside a spaces program. */
export const spacesQuery = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: spacesQueryFailed })
