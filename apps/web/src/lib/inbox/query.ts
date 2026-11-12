import { Effect, Schema } from 'effect'

/**
 * A failed read in an inbox module. One class for the directory's
 * database reads, so a reader learns one name.
 * - `message` is the cause's own, so a caller that prints a rejected call's
 *   message reads what it read before the call was a program.
 */
export class InboxReadFailed extends Schema.TaggedError<InboxReadFailed>()(
  'InboxReadFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The failure for a thrown cause. */
const inboxReadFailed = (cause: unknown) =>
  new InboxReadFailed({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })

/** A database call inside an inbox program. */
export const inboxRead = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: inboxReadFailed })
