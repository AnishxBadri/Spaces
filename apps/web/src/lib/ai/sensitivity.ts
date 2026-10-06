/** The sensitivity resolver lives in core, beside the one writer of `chunk.sensitive`. */
export {
  resolveSensitivity,
  workspaceDefaultOf,
} from '@spaces/core/ai/sensitivity'
export type {
  AiSensitivity,
  BindingSensitivity,
  ResolvedSensitivity,
  SensitivityInputs,
  SensitivityVia,
} from '@spaces/core/ai/sensitivity'
