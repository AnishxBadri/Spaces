import { Effect } from 'effect'

/**
 * The one Effect → TanStack seam (CONTEXT.md "Backend paradigm", ratchet
 * step zero). Server-fn handlers stay async functions; Effect programs run
 * inside them through this adapter. Effect never crosses into React — typed
 * failures reject the promise and surface through the existing server-fn
 * error path.
 */
export const effectFn =
  <TArgs extends Array<unknown>, TValue, TError>(
    f: (...args: TArgs) => Effect.Effect<TValue, TError>,
  ) =>
  (...args: TArgs): Promise<TValue> =>
    Effect.runPromise(f(...args))
