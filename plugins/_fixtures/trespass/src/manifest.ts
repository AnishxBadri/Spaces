import { Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/** One harmless job; the fixture exists for its migrations. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'trespass',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'trespass',
  description:
    'A containment fixture: its second migration reaches into public and is refused.',
  settings: Schema.Struct({}),
  jobs: {
    ping: { trigger: 'action', uses: ['Log'] },
  },
})
