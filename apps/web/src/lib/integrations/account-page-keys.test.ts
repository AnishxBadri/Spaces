import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { manifestSchema, settingsJsonSchema } from '@spaces/sdk'
import { withoutAccountPageKeys } from './ledger'
import { settingsFormOf } from './settings-form'

/**
 * A mail syncer's sharing switch and exclude list are its connection's, on
 * the account page for the mailbox's owner — never on the plugin page, where
 * an admin would decide who reads someone else's mail.
 */
const manifestWith = (roles: Array<'email-calendar' | 'enrichment'>) =>
  Schema.decodeUnknownSync(manifestSchema)({
    manifestVersion: 1,
    id: 'gmail',
    version: '0.1.0',
    sdk: '^1.4',
    name: 'Gmail',
    description: 'Mail.',
    roles,
    settings: settingsJsonSchema(
      Schema.Struct({
        shareBodies: Schema.Boolean.pipe(
          Schema.withDecodingDefaultKey(Effect.succeed(false)),
        ),
        excludeSenders: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefaultKey(Effect.succeed([])),
        ),
        excludeLabels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefaultKey(Effect.succeed([])),
        ),
        signature: Schema.String.pipe(
          Schema.withDecodingDefaultKey(Effect.succeed('')),
        ),
      }),
    ),
    jobs: {
      sync: {
        trigger: 'schedule',
        schedule: '*/5 * * * *',
        uses: ['Content'],
      },
    },
  })

describe('withoutAccountPageKeys', () => {
  it('leaves an email-calendar plugin’s page only what is not the account’s', () => {
    const form = settingsFormOf(
      withoutAccountPageKeys(manifestWith(['email-calendar'])),
    )
    expect(form.ok && form.fields.map((f) => f.key)).toEqual(['signature'])
  })

  it('leaves any other plugin’s settings as declared', () => {
    const manifest = manifestWith(['enrichment'])
    expect(withoutAccountPageKeys(manifest)).toBe(manifest.settings)
  })
})
