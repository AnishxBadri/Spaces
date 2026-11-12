import { Effect, Schema } from 'effect'

/**
 * A failed read or write in a portfolio module. One class for the
 * directory's database calls, so a reader learns one name.
 * - `message` is the cause's own, so a caller that prints a rejected call's
 *   message reads what it read before the call was a program.
 */
export class PortfolioQueryFailed extends Schema.TaggedError<PortfolioQueryFailed>()(
  'PortfolioQueryFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The failure for a thrown cause. */
export const portfolioQueryFailed = (cause: unknown) =>
  new PortfolioQueryFailed({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })

/** A database call inside a portfolio program. */
export const portfolioQuery = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: portfolioQueryFailed })
