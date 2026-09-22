import { z } from 'zod'
import type { AiLane, AiSensitivity } from '@spaces/db/schema/ai'
import { LLM_PROVIDERS } from './providers/ids'

/**
 * The routing vocabulary, client-safe: the server-fn validator below is
 * evaluated in the client bundle too, so this module imports the database
 * enums as types only. The two lists are held to `ai_lane` and
 * `ai_sensitivity` by the `Exact` checks under them — a lane added to the
 * enum and not here is a type error, not a silently unroutable lane.
 */

export const AI_LANES = [
  'extract',
  'classify',
  'synthesize',
  'embed',
  'vision',
  'research',
] as const satisfies readonly AiLane[]

export const AI_SENSITIVITIES = [
  'normal',
  'sensitive',
] as const satisfies readonly AiSensitivity[]

type Exact<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : never
  : never
const lanesExact: Exact<(typeof AI_LANES)[number], AiLane> = true
const sensitivitiesExact: Exact<
  (typeof AI_SENSITIVITIES)[number],
  AiSensitivity
> = true
void lanesExact
void sensitivitiesExact

export type { AiLane, AiSensitivity }

const aiRouteCell = {
  lane: z.enum(AI_LANES),
  sensitivity: z.enum(AI_SENSITIVITIES),
}

/** One cell of the lane × sensitivity grid, routed to a provider's model. */
export const aiRouteSetInput = z.object({
  ...aiRouteCell,
  provider: z.enum(LLM_PROVIDERS),
  model: z.string().trim().min(1).max(200),
})
export type AiRouteSetInput = z.infer<typeof aiRouteSetInput>

/**
 * `setAiRoute`'s input: a cell set to a provider and model, or cleared with
 * `provider: null` — which deletes the row, leaving the lane unrouted at that
 * sensitivity (SPA-69).
 */
export const aiRouteInput = z.union([
  aiRouteSetInput,
  z.object({ ...aiRouteCell, provider: z.null() }),
])
export type AiRouteInput = z.infer<typeof aiRouteInput>

/** `isLaneRouted`'s input: the lane a trigger belongs to. */
export const aiLaneInput = z.object({ lane: z.enum(AI_LANES) })
