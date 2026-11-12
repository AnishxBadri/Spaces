import { Effect, Schema } from 'effect'
import { settingsJsonSchema } from '@spaces/sdk'

/**
 * Plugin settings as the plugin build emits them into `manifest.json`, for
 * the component tests: the components may not import Effect, the schemas a
 * plugin authors are Effect schemas.
 */

const withDefault = Schema.withDecodingDefaultKey

/** One field of each kind the form draws, with a hint and an optional one. */
export const everyKindSettings = settingsJsonSchema(
  Schema.Struct({
    cacheDays: Schema.Int.annotate({ description: 'days' })
      .check(Schema.isBetween({ minimum: 0, maximum: 3650 }))
      .pipe(withDefault(Effect.succeed(90))),
    autoEnrich: Schema.Boolean.pipe(withDefault(Effect.succeed(false))),
    region: Schema.Literals(['us', 'eu']).pipe(
      withDefault(Effect.succeed('us' as const)),
    ),
    label: Schema.optionalKey(Schema.String),
  }),
)

/** A list setting: the form refuses to draw it. */
export const listSettings = settingsJsonSchema(
  Schema.Struct({ feeds: Schema.Array(Schema.String) }),
)

/** An enrichment source's two settings, both defaulted. */
export const enrichmentSettings = settingsJsonSchema(
  Schema.Struct({
    cacheDays: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: 3650 }),
    ).pipe(withDefault(Effect.succeed(90))),
    autoEnrich: Schema.Boolean.pipe(withDefault(Effect.succeed(false))),
  }),
)
