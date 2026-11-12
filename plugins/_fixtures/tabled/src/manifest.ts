import { Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/** One action job that writes to the plugin's own table. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'tabled',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'tabled',
  description:
    'A PluginDb fixture: two migrations in its own schema and a job that writes there.',
  settings: Schema.Struct({}),
  jobs: {
    note: { trigger: 'action', uses: ['PluginDb'] },
  },
})
