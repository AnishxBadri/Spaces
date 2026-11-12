import { Effect, Schema } from 'effect'

/**
 * A failed read or write in a members module. One class for the directory's
 * database calls, so a reader learns one name.
 * - `message` is the cause's own, so a caller that prints a rejected call's
 *   message reads what it read before the call was a program.
 */
export class MembersQueryFailed extends Schema.TaggedError<MembersQueryFailed>()(
  'MembersQueryFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The failure for a thrown cause. */
const membersQueryFailed = (cause: unknown) =>
  new MembersQueryFailed({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })

/** A database call inside a members program. */
export const membersQuery = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: membersQueryFailed })
