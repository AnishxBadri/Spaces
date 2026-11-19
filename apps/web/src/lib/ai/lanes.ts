import { Schema } from 'effect'
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
  lane: Schema.Literals(AI_LANES),
  sensitivity: Schema.Literals(AI_SENSITIVITIES),
}

/** One cell of the lane × sensitivity grid, routed to a provider's model. */
export const aiRouteSetInput = Schema.Struct({
  ...aiRouteCell,
  provider: Schema.Literals(LLM_PROVIDERS),
  model: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})
export type AiRouteSetInput = typeof aiRouteSetInput.Type

/**
 * `setAiRoute`'s input: a cell set to a provider and model, or cleared with
 * `provider: null` — which deletes the row, leaving the lane unrouted at that
 * sensitivity.
 */
export const aiRouteInput = Schema.Union([
  aiRouteSetInput,
  Schema.Struct({ ...aiRouteCell, provider: Schema.Null }),
])
export type AiRouteInput = typeof aiRouteInput.Type

/** `isLaneRouted`'s input: the lane a trigger belongs to. */
export const aiLaneInput = Schema.Struct({ lane: Schema.Literals(AI_LANES) })

/**
 * The lanes the Models routing grid draws: every lane but `embed`, which
 * Search owns. The router still routes `embed`.
 */
export const MODELS_GRID_LANES = AI_LANES.filter((lane) => lane !== 'embed')

/**
 * `setSensitivityDefault`'s input: the workspace floor, which can only raise
 * a record's sensitivity, never lower it.
 */
export const sensitivityDefaultInput = Schema.Struct({
  sensitivity: Schema.Literals(AI_SENSITIVITIES),
})
export type SensitivityDefaultInput = typeof sensitivityDefaultInput.Type
