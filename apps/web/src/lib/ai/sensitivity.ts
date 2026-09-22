import type { AiSensitivity } from './lanes'

/**
 * Where `sensitive` is decided (SPA-61; docs/spec-ai-substrate.md §9,
 * docs/spec-storage-sources.md §9, §11.7). `resolveSensitivity` is the only
 * function in `src/**` that decides the value; everything else passes its
 * answer along.
 *
 * Three authored inputs and no more:
 *
 * - `entity.sensitive` — the record's own flag, one column for a space, a
 *   company, a deal, a document and a custom record alike;
 * - the spaces the record is filed in, and every ltree ancestor of one (and,
 *   for a space, its own ancestors) — each is an entity with its own flag;
 * - the producing storage binding's `sensitivity` (`inherit | sensitive`);
 *
 * floored by `workspace.settings.sensitivity_default`. The OR is cautious:
 * one sensitive input anywhere makes the record sensitive, and nothing an
 * input says can make another one less so. A record filed nowhere resolves
 * the workspace default; it never throws.
 *
 * The resolver is authoritative at every boundary where bytes leave the box
 * — `complete()`, `embed()` and later vision resolve live, one query per job
 * (`sensitivityFor`, `./sensitivity-for.ts`), never a cached column: a stale
 * cache there is a leak, while a join at job granularity is free.
 *
 * `embed()` does not exist yet (ai-9a, project 11). Its policy is settled
 * here so it is not re-derived there: **skip, never leak** — a sensitive
 * record whose embed lane routes to a non-local provider fails
 * `SensitiveRouteRefused` and is left unembedded until the sensitive
 * embedding slot (a local embedding model routed at `embed × sensitive`)
 * exists; it is never sent to the cloud embedder as a fallback.
 *
 * This module is pure — no drizzle, no Effect — so it is unit-tested with no
 * Postgres and importable from the client for the marker's types.
 */

export type { AiSensitivity }

/** A storage binding's authored setting (storage-8a). */
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
