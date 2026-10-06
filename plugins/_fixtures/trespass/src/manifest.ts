import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** One harmless job; the fixture exists for its migrations. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'trespass',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'trespass',
  description:
    'A containment fixture: its second migration reaches into public and is refused.',
  settings: z.object({}),
  jobs: {
    ping: { trigger: 'action', uses: ['Log'] },
  },
})
