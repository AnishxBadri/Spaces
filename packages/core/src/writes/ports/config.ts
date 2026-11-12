import {
  Effect,
  Layer,
  Predicate,
  Result,
  Schema,
  SchemaIssue,
  SchemaParser,
} from 'effect'
import { Config } from '@spaces/sdk'
import type { SettingsSchema } from '@spaces/sdk'
import type { BoundIntegration } from './binding'

/**
 * ConfigLive: `integration.config`, validated against the bundle's
 * `manifest.settings` schema when the Layer is built (the manifest's JSON Schema is
 * only for web's form). A row whose config
 * does not parse fails the Layer with `ConfigInvalid`, naming the field,
 * which the loader turns into `degraded` rather than a crash; a job never
 * starts on a config its plugin would refuse.
 *
 * A required setting with no value and no default is not an error but a
 * row not set up yet: the reason is then exactly {@link MISSING_SETTINGS},
 * the settings twin of the loader's 'missing credential', which web reads
 * as `not yet`. A value present and wrong keeps the field-naming reason.
 *
 * `get()` serves the row's config as stored. `configOf(manifest)` in the
 * SDK is the typed read: it decodes again with the same schema, so defaults
 * apply and the value carries the plugin's own type.
 */
/** `last_error` for a row whose config lacks a required setting that has no default. */
export const MISSING_SETTINGS = 'missing settings'

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()(
  'ConfigInvalid',
  {
    pluginId: Schema.String,
    /** The failing field's path, dot-joined; empty for the root. */
    path: Schema.String,
    reason: Schema.String,
  },
) {}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** Each issue with its path as plain keys. */
const issuesOf = (issue: SchemaIssue.Issue) =>
  formatIssues(issue).issues.map(({ message, path }) => ({
    message,
    path: (path ?? []).map((s) => (Predicate.isObject(s) ? s.key : s)),
  }))

export const ConfigLive = (
  row: BoundIntegration,
  settings: SettingsSchema,
): Layer.Layer<Config, ConfigInvalid> =>
  Layer.effect(
    Config,
    Effect.gen(function* () {
      const parsed = SchemaParser.decodeUnknownResult(settings, {
        errors: 'all',
      })(row.config)
      if (Result.isFailure(parsed)) {
        const issues = issuesOf(parsed.failure)
        // A top-level key the row lacks failed: the schema requires it and
        // gives it no default (a default or `optional` would have passed).
        const missing = issues
          .map((i) => (i.path.length === 1 ? i.path.at(0) : undefined))
          .find(
            (key): key is string =>
              typeof key === 'string' && !Object.hasOwn(row.config, key),
          )
        if (missing !== undefined) {
          return yield* new ConfigInvalid({
            pluginId: row.capabilityId,
            path: missing,
            reason: MISSING_SETTINGS,
          })
        }
        const issue = issues.at(0)
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
