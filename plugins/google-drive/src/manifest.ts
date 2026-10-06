import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** A Drive file or folder id, as the settings form checks it. */
export const DRIVE_ID = /^[\w-]+$/

/**
 * Google Drive's manifest: a storage source.
 * - `provides: 'storage-source'`, so `definePlugin` requires the provider
 *   and no job may use Facts or Ai — it delivers bytes and never files them.
 * - The connection asks `drive.file` only: files picked in Google's
 *   picker. `drive.readonly` is asked for when a whole folder is bound,
 *   never at install. (D66)
 * - `list` is the demo job: one row is one folder, walked and logged.
 * - `sdk: '^1.1'` so this host loads it today; the storage-source members
 *   and `Http.stream` arrive in the next SDK minor.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'google-drive',
  version: '0.1.0',
  sdk: '^1.1',
  name: 'Google Drive',
  description:
    'Reads Google Drive: resolves pasted links, lists folders and fetches files, exporting native Docs, Sheets and Slides; reports what changed by Drive’s own version, never by a hash of the export.',
  requires: { connection: { provider: 'google', scopes: ['drive.file'] } },
  provides: 'storage-source',
  settings: z.object({
    folderId: z.string().regex(DRIVE_ID).meta({
      title: 'Folder id',
      description:
        'The Drive folder the list job walks — the id at the end of its link.',
    }),
  }),
  jobs: {
    list: {
      trigger: 'schedule',
      schedule: '0 6 * * *',
      uses: ['Config', 'Http', 'Secrets', 'Log'],
    },
  },
})
