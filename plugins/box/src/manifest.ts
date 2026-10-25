import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** A Box folder id, as the settings form checks it: Box's ids are digits. */
export const BOX_ID = /^\d+$/

/**
 * Box's manifest: a storage source.
 * - `provides: 'storage-source'`, so `definePlugin` requires the provider
 *   and no job may use Facts or Ai — it delivers bytes and never files them.
 * - The connection asks `root_readonly` at install: Box has no per-file
 *   grant, so the read half reads what the account can see. The write half
 *   needs `root_readwrite`, asked for when a binding pushes, never at
 *   install — as Drive asks `drive.readonly` only at bind time.
 * - `list` is the demo job: one row is one folder, walked and logged.
 * - `sdk: '^1.4'`: the first SDK with `roles`.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'box',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Box',
  roles: ['files'],
  description:
    'Reads and writes Box: resolves pasted links, lists folders and fetches files, reading Box Notes as text; reports what changed from Box’s events stream, by Box’s own etag, never by a hash; creates folders, uploads files and moves or renames them for a binding that pushes.',
  requires: { connection: { provider: 'box', scopes: ['root_readonly'] } },
  provides: 'storage-source',
  settings: z.object({
    folderId: z.string().regex(BOX_ID).meta({
      title: 'Folder id',
      description:
        'The Box folder the list job walks — the number at the end of its link.',
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
