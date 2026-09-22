import { Effect, Schema } from 'effect'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { aiRoute, credential } from '@spaces/db/schema'
import { effectFn } from '#/lib/server/effect'
import { requireAdmin, requireUser } from '#/lib/server/shared'
import { LLM_PROVIDERS } from './providers/ids'
import type { LlmProvider } from './providers/ids'
import { AI_SENSITIVITIES } from './lanes'
import type {
  AiLane,
  AiRouteInput,
  AiRouteSetInput,
  AiSensitivity,
} from './lanes'

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
  input: AiRouteSetInput,
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

/**
 * The `setAiRoute` server fn's body. `requireAdmin()` first. A `null`
 * provider clears the cell (SPA-69).
 */
export async function setAiRouteHandler(
  input: AiRouteInput,
): Promise<AiRouteCell> {
  await requireAdmin()
  if (input.provider === null) {
    await effectFn(clearAiRouteProgram)(input.lane, input.sensitivity)
    return { lane: input.lane, sensitivity: input.sensitivity, target: null }
  }
  const { provider, model } = await effectFn(setAiRouteProgram)(input)
  return {
    lane: input.lane,
    sensitivity: input.sensitivity,
    target: { provider, model },
  }
}

// SPA-69: the Routing ledger and the trigger gate.

/** One cell of the routing grid as the Routing ledger reads it. */
export type AiRouteCell = {
  lane: AiLane
  sensitivity: AiSensitivity
  target: AiTarget | null
}

/** Clears one cell: the row goes, and the lane is unrouted there. */
export const clearAiRouteProgram = Effect.fn('clearAiRoute')(function* (
  lane: AiLane,
  sensitivity: AiSensitivity,
): Effect.fn.Return<void, RouteReadFailed> {
  yield* read(() =>
    db
      .delete(aiRoute)
      .where(and(eq(aiRoute.lane, lane), eq(aiRoute.sensitivity, sensitivity))),
  )
})

/**
 * Every stored route. A row naming a provider this build has no adapter for
 * is not a route and is left out.
 */
export const listAiRoutesProgram = Effect.fn('listAiRoutes')(
  function* (): Effect.fn.Return<AiRouteCell[], RouteReadFailed> {
    const rows = yield* read(() =>
      db
        .select({
          lane: aiRoute.lane,
          sensitivity: aiRoute.sensitivity,
          provider: aiRoute.provider,
          model: aiRoute.model,
        })
        .from(aiRoute)
        .orderBy(asc(aiRoute.lane), asc(aiRoute.sensitivity)),
    )
    const cells: AiRouteCell[] = []
    for (const row of rows) {
      const provider = row.provider
      if (!isLlmProvider(provider)) continue
      cells.push({
        lane: row.lane,
        sensitivity: row.sensitivity,
        target: { provider, model: row.model },
      })
    }
    return cells
  },
)

const workspaceKey = and(
  eq(credential.scope, 'workspace'),
  isNull(credential.userId),
)

/**
 * Whether a call by `userId` would resolve an active credential for
 * `provider` — the workspace key, or the caller's own (the vault's resolution
 * order), read without decrypting or touching anything.
 */
const hasActiveCredential = (provider: LlmProvider, userId: string | null) =>
  read(() =>
    db
      .select({ id: credential.id })
      .from(credential)
      .where(
        and(
          eq(credential.provider, provider),
          eq(credential.status, 'active'),
          userId === null
            ? workspaceKey
            : or(
                workspaceKey,
                and(
                  eq(credential.scope, 'user'),
                  eq(credential.userId, userId),
                ),
              ),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length > 0))

export type LaneRouted = Record<AiSensitivity, boolean>

/**
 * The gate every AI trigger hides itself on (SPA-69): per sensitivity, true
 * only when the lane has a route, the routed provider has an active
 * credential, and — for `sensitive` — the provider is local; the three things
 * `complete()` would otherwise refuse on. It never fails: a read error reads
 * as unrouted, because a trigger that cannot tell is hidden.
 */
export const isLaneRoutedProgram = Effect.fn('isLaneRouted')(function* (
  lane: AiLane,
  userId: string | null,
): Effect.fn.Return<LaneRouted> {
  const result: LaneRouted = { normal: false, sensitive: false }
  for (const sensitivity of AI_SENSITIVITIES) {
    result[sensitivity] = yield* aiRouteProgram(lane, sensitivity).pipe(
      Effect.flatMap((target) =>
        sensitivity === 'sensitive' && !isLocalProvider(target.provider)
          ? Effect.succeed(false)
          : hasActiveCredential(target.provider, userId),
      ),
      Effect.catch(() => Effect.succeed(false)),
    )
  }
  return result
})

/**
 * The `isLaneRouted` server fn's body. Any signed-in member may ask; a
 * request with no session reads as unrouted rather than throwing.
 */
export async function isLaneRoutedHandler(input: {
  lane: AiLane
}): Promise<LaneRouted> {
  const user = await requireUser().catch(() => null)
  if (!user) return { normal: false, sensitive: false }
  return effectFn(isLaneRoutedProgram)(input.lane, user.id)
}

/** The `listAiRoutes` server fn's body. `requireAdmin()` first. */
export async function listAiRoutesHandler(): Promise<AiRouteCell[]> {
  await requireAdmin()
  return effectFn(listAiRoutesProgram)()
}
