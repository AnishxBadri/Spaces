import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'tampered',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'tampered',
  description:
    'A loader fixture (sdk-11): the test edits its bundle after writing its lock.json entry.',
  settings: z.object({}),
  jobs: {
    ping: { trigger: 'action', uses: ['Log'] },
  },
})
