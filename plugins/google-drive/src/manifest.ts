import { Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/** A Drive file or folder id, as the settings form checks it. */
export const DRIVE_ID = /^[\w-]+$/

/**
 * Google Drive's manifest: a storage source.
 * - `provides: 'storage-source'`, so `definePlugin` requires the provider
 *   and no job may use Facts or Ai — it delivers bytes and never files them.
 * - The connection asks `drive.file` only: files picked in Google's
 *   picker. `drive.readonly` is asked for when a whole folder is bound,
 *   never at install.
 * - `list` is the demo job: one row is one folder, walked and logged.
 * - `pickerApiKey` and `pickerAppId` are what Google's picker needs from the
 *   same Cloud project as the OAuth client; without them the Files tab
 *   says the picker is not set up.
 * - `sdk: '^2.0'`: settings are an Effect schema.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'google-drive',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'Google Drive',
  roles: ['files'],
  description:
    'Reads Google Drive: resolves pasted links, lists folders and fetches files, exporting native Docs, Sheets and Slides; reports what changed by Drive’s own version, never by a hash of the export.',
  requires: { connection: { provider: 'google', scopes: ['drive.file'] } },
  provides: 'storage-source',
  settings: Schema.Struct({
    folderId: Schema.String.annotate({
      title: 'Folder id',
      description:
        'The Drive folder the list job walks — the id at the end of its link.',
    }).check(Schema.isPattern(DRIVE_ID)),
    pickerApiKey: Schema.optionalKey(
      Schema.String.annotate({
        title: 'Picker API key',
        description:
          'An API key from the Cloud project that holds the Google OAuth client, restricted to the Picker API.',
      }).check(Schema.isMinLength(1)),
    ),
    pickerAppId: Schema.optionalKey(
      Schema.String.annotate({
        title: 'Picker app id',
        description: 'That Cloud project’s project number.',
      }).check(Schema.isPattern(/^\d+$/)),
    ),
  }),
  jobs: {
    list: {
      trigger: 'schedule',
      schedule: '0 6 * * *',
      uses: ['Config', 'Http', 'Secrets', 'Log'],
    },
  },
})
