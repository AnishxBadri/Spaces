import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'old-sdk',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'old-sdk',
  description:
    'A loader fixture (sdk-11): built against an SDK major this host does not provide, so boot degrades it.',
  settings: z.object({}),
  jobs: {
    ping: { trigger: 'action', uses: ['Log'] },
  },
})
