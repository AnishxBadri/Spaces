import { Effect, Schema } from 'effect'

/** A failed read or write of Ask's store; the cause stays on the server. */
export class AskQueryFailed extends Schema.TaggedError<AskQueryFailed>()(
  'AskQueryFailed',
  { cause: Schema.Defect() },
) {}

export const askQuery = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AskQueryFailed({ cause }),
  })
