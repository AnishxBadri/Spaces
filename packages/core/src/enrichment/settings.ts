import { z } from 'zod'
import { manifestSchema } from '@spaces/sdk'
import { autoEnrichScopeOf } from '@spaces/core/plugins/auto-enrich'
import type { AutoEnrichScope } from '@spaces/core/plugins/auto-enrich'

/**
 * The owner's enrichment settings, `workspace.settings.enrichment` (D76):
 * - `sources`: integration ids in the order they are asked;
 * - `reuseDays`: a source's receipt younger than this is reused, not re-asked;
 * - `scopes`: per integration id, which triggers auto-enrich.
 * Each falls back to what the integration rows still hold (`cacheDays`,
 * `autoEnrichScopes`/`autoEnrichSpaces` on `integration.config`) until the
 * settings form writes the new home.
 */

export type EnrichmentSettings = {
  /** Null when the owner has set no order. */
  readonly sources: ReadonlyArray<string> | null
  /** Null when unset: each source's own `cacheDays` applies. */
  readonly reuseDays: number | null
  readonly scopes: ReadonlyMap<string, AutoEnrichScope>
}

const storedScope = z.object({
  scopes: z.array(z.unknown()).optional(),
  spaces: z.array(z.unknown()).optional(),
})

const stored = z.object({
  sources: z.array(z.uuid()).optional().catch(undefined),
  reuseDays: z.int().min(0).max(3650).optional().catch(undefined),
  scopes: z
    .record(z.string(), storedScope.catch({}))
    .optional()
    .catch(undefined),
})

/** Read cautiously: a malformed part reads as unset, never as a refusal. */
export const enrichmentSettingsOf = (settings: {
  readonly [key: string]: unknown
}): EnrichmentSettings => {
  const parsed = stored.safeParse(settings['enrichment'])
  const data = parsed.success ? parsed.data : {}
  const scopes = new Map<string, AutoEnrichScope>()
  for (const [id, scope] of Object.entries(data.scopes ?? {}))
    scopes.set(
      id,
      autoEnrichScopeOf({
        autoEnrichScopes: scope.scopes ?? [],
        autoEnrichSpaces: scope.spaces ?? [],
      }),
    )
  return {
    sources: data.sources ?? null,
    reuseDays: data.reuseDays ?? null,
    scopes,
  }
}

/** An integration's auto-enrich scope: the workspace's, else its row's. */
export const scopeFor = (
  settings: EnrichmentSettings,
  integrationId: string,
  config: { readonly [key: string]: unknown },
): AutoEnrichScope =>
  settings.scopes.get(integrationId) ?? autoEnrichScopeOf(config)

/** The action a source answers a kind with: `on` that kind, id `enrich…`. */
export type EnrichAction = { readonly id: string; readonly job: string }

export const enrichActionFor = (
  manifest: unknown,
  kind: 'company' | 'person',
): EnrichAction | null => {
  const parsed = manifestSchema.safeParse(manifest)
  if (!parsed.success) return null
  const action = (parsed.data.actions ?? []).find(
    (a) => a.on === kind && a.id.startsWith('enrich'),
  )
  return action === undefined ? null : { id: action.id, job: action.job }
}

/**
 * The sources to ask, in order: the owner's list when set (ids it names
 * that are not runnable are dropped), else every runnable row with an
 * enrich action, oldest first.
 */
export const orderSources = <TRow extends { readonly id: string }>(
  settings: EnrichmentSettings,
  rows: ReadonlyArray<TRow>,
): ReadonlyArray<TRow> =>
  settings.sources === null
    ? rows
    : settings.sources.flatMap((id) => rows.filter((r) => r.id === id))

/**
 * The order with a built-in source in it: where the owner's list puts it,
 * else first — the Website is on for every record from install (D76).
 */
export const withBuiltIn = <TRow extends { readonly id: string }>(
  settings: EnrichmentSettings,
  builtIn: TRow | null,
  rows: ReadonlyArray<TRow>,
): ReadonlyArray<TRow> => {
  if (builtIn === null) return orderSources(settings, rows)
  if (settings.sources?.includes(builtIn.id) === true)
    return orderSources(settings, [builtIn, ...rows])
  return [builtIn, ...orderSources(settings, rows)]
}
