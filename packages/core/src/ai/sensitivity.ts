import type { AiSensitivity } from '@spaces/db/schema/ai'

/**
 * Where `sensitive` is decided: `resolveSensitivity` is the only function
 * that decides the value; everything else passes its answer along.
 *
 * - Three authored inputs: the record's own `entity.sensitive`; the spaces it
 *   is filed in and every ltree ancestor of one (for a space, its own
 *   ancestors); the producing storage binding's `sensitivity`. Floored by
 *   `workspace.settings.sensitivity_default`.
 * - The OR is cautious: one sensitive input makes the record sensitive, and
 *   no input can make another less so. A record filed nowhere resolves the
 *   workspace default; it never throws.
 * - Every boundary where bytes leave the box resolves live (`sensitivityFor`),
 *   never from the cached `chunk.sensitive`: a stale cache there is a leak.
 * - `embed()` skips, never leaks: a sensitive record with no local embedder
 *   is left unembedded, never sent to the cloud one.
 *
 * Pure — no drizzle, no Effect — so the client imports it for the marker's
 * types.
 */

export type { AiSensitivity }

/** A storage binding's authored setting. */
export type BindingSensitivity = 'inherit' | 'sensitive'

/** Which input made a record sensitive — what the marker and a refusal name. */
export type SensitivityVia =
  | { kind: 'own' }
  | { kind: 'space'; name: string }
  | { kind: 'binding'; name?: string }
  | { kind: 'default' }

/** The answer: `via` is present exactly when the record is sensitive. */
export type ResolvedSensitivity =
  { sensitivity: 'normal' } | { sensitivity: 'sensitive'; via: SensitivityVia }

export type SensitivityInputs = {
  own: boolean
  /** Filed spaces and their ancestors, nearest first. */
  spaces: ReadonlyArray<{ sensitive: boolean; name: string }>
  /** The producing binding; null when the record came from none. */
  binding: { sensitivity: BindingSensitivity; name?: string } | null
  workspaceDefault: AiSensitivity
}

/**
 * The cautious OR. `via` names the most specific input that decided it —
 * the record's own flag, then the nearest sensitive space, then the binding,
 * then the workspace default — so a refusal can say where it came from.
 */
export function resolveSensitivity(
  inputs: SensitivityInputs,
): ResolvedSensitivity {
  if (inputs.own) return { sensitivity: 'sensitive', via: { kind: 'own' } }
  const space = inputs.spaces.find((s) => s.sensitive)
  if (space)
    return {
      sensitivity: 'sensitive',
      via: { kind: 'space', name: space.name },
    }
  if (inputs.binding?.sensitivity === 'sensitive')
    return {
      sensitivity: 'sensitive',
      via:
        inputs.binding.name === undefined
          ? { kind: 'binding' }
          : { kind: 'binding', name: inputs.binding.name },
    }
  if (inputs.workspaceDefault === 'sensitive')
    return { sensitivity: 'sensitive', via: { kind: 'default' } }
  return { sensitivity: 'normal' }
}

/** A stored `sensitivity_default`, read cautiously: absent means normal. */
export const workspaceDefaultOf = (value: unknown): AiSensitivity =>
  value === 'sensitive' ? 'sensitive' : 'normal'
