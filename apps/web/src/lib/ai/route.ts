import { Effect, Schema } from 'effect'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { aiRoute } from '@spaces/db/schema'
import { effectFn } from '#/lib/server/effect'
import { requireAdmin } from '#/lib/server/shared'
import { LLM_PROVIDERS } from './providers/ids'
import type { LlmProvider } from './providers/ids'
import type { AiLane, AiRouteInput, AiSensitivity } from './lanes'

/**
 * The router (docs/spec-ai-substrate.md §4, §9): lane × sensitivity →
 * `{provider, model}`, read from the `ai_route` settings table. Features name
 * a lane, never a model; this module is the one place a lane becomes one.
 *
 * It does not decide sensitivity — the caller supplies it (ai-26 resolves
 * it) — and it does not refuse a sensitive route to the cloud: that is
 * `complete()`'s check, made against whatever target it ends up with.
 */

export type AiTarget = { provider: LlmProvider; model: string }

/**
 * Providers that run on the operator's own box. A `sensitive` call goes to
 * one of these or nowhere — never to the cloud as a fallback.
 */
export const LOCAL_PROVIDERS = [
  'ollama',
] as const satisfies readonly LlmProvider[]

export const isLocalProvider = (provider: LlmProvider): boolean =>
  LOCAL_PROVIDERS.some((p) => p === provider)

const isLlmProvider = (value: string): value is LlmProvider =>
  LLM_PROVIDERS.some((p) => p === value)

/** No route is configured for this lane at this sensitivity. */
export class LaneNotRouted extends Schema.TaggedError<LaneNotRouted>()(
  'LaneNotRouted',
  { lane: Schema.String, sensitivity: Schema.String },
) {}

export class RouteReadFailed extends Schema.TaggedError<RouteReadFailed>()(
  'RouteReadFailed',
  { cause: Schema.Defect() },
) {}

const read = <T>(f: () => Promise<T>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new RouteReadFailed({ cause }),
  })

export const aiRouteProgram = Effect.fn('aiRoute')(function* (
  lane: AiLane,
  sensitivity: AiSensitivity,
): Effect.fn.Return<AiTarget, LaneNotRouted | RouteReadFailed> {
  const row = (yield* read(() =>
    db
      .select({ provider: aiRoute.provider, model: aiRoute.model })
      .from(aiRoute)
      .where(and(eq(aiRoute.lane, lane), eq(aiRoute.sensitivity, sensitivity)))
      .limit(1),
  )).at(0)
  if (!row) return yield* new LaneNotRouted({ lane, sensitivity })
  const provider = row.provider
  // Written through `setAiRoute`, whose validator holds the provider id; a
  // row that says otherwise was written by hand and is not a route.
  if (!isLlmProvider(provider))
    return yield* new RouteReadFailed({
      cause: new Error(`ai_route names an unknown provider: ${provider}`),
    })
  return { provider, model: row.model }
})

/**
 * The lane a provider's Test call is recorded under: the first lane routed to
 * it (normal sensitivity before sensitive, lanes in enum order), with that
 * route's model. Null when no route names the provider.
 */
export const routeForProviderProgram = Effect.fn('routeForProvider')(function* (
  provider: LlmProvider,
): Effect.fn.Return<{ lane: AiLane; model: string } | null, RouteReadFailed> {
  const row = (yield* read(() =>
    db
      .select({ lane: aiRoute.lane, model: aiRoute.model })
      .from(aiRoute)
      .where(eq(aiRoute.provider, provider))
      .orderBy(asc(aiRoute.sensitivity), asc(aiRoute.lane))
      .limit(1),
  )).at(0)
  return row ?? null
})

/** One cell of the routing grid, upserted on `(lane, sensitivity)`. */
export const setAiRouteProgram = Effect.fn('setAiRoute')(function* (
  input: AiRouteInput,
): Effect.fn.Return<AiTarget & { lane: AiLane }, RouteReadFailed> {
  yield* read(() =>
    db
      .insert(aiRoute)
      .values(input)
      .onConflictDoUpdate({
        target: [aiRoute.lane, aiRoute.sensitivity],
        set: {
          provider: input.provider,
          model: input.model,
          updatedAt: sql`now()`,
        },
      }),
  )
  return { lane: input.lane, provider: input.provider, model: input.model }
})

/** The `setAiRoute` server fn's body. `requireAdmin()` first. */
export async function setAiRouteHandler(
  input: AiRouteInput,
): Promise<AiTarget & { lane: AiLane }> {
  await requireAdmin()
  return effectFn(setAiRouteProgram)(input)
}
