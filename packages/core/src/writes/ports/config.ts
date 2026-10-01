import { Effect, Layer, Schema } from 'effect'
import { z } from 'zod'
import { Config } from '@spaces/sdk'
import type { BoundIntegration } from './binding'

/**
 * ConfigLive (sdk-6a): `integration.config`, validated against the plugin's
 * own settings schema when the Layer is built — the zod schema the bundle
 * exports on `manifest.settings`, which the worker's loader holds. (The
 * manifest's JSON Schema is for web's form, project 19.) A row whose config
 * does not parse fails the Layer with `ConfigInvalid`, naming the field,
 * which the loader turns into `degraded` rather than a crash; a job never
 * starts on a config its plugin would refuse.
 *
 * `get()` serves the row's config as stored. `configOf(manifest)` in the
 * SDK is the typed read: it parses again with the same schema, so defaults
 * apply and the value carries the plugin's own type.
 */
export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()(
  'ConfigInvalid',
  {
    pluginId: Schema.String,
    /** The failing field's path, dot-joined; empty for the root. */
    path: Schema.String,
    reason: Schema.String,
  },
) {}

export const ConfigLive = (
  row: BoundIntegration,
  settings: z.ZodType,
): Layer.Layer<Config, ConfigInvalid> =>
  Layer.effect(
    Config,
    Effect.gen(function* () {
      const parsed = z.safeParse(settings, row.config)
      if (!parsed.success) {
        const issue = parsed.error.issues.at(0)
        const path = issue?.path.map(String).join('.') ?? ''
        return yield* new ConfigInvalid({
          pluginId: row.capabilityId,
          path,
          reason: `${row.capabilityId}'s config is invalid at ${path === '' ? '(root)' : path}: ${issue?.message ?? 'does not match its settings'}`,
        })
      }
      const config = row.config
      return Config.of({ get: () => Effect.succeed(config) })
    }),
  )
