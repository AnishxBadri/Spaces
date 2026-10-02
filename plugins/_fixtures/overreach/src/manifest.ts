import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** One action job granted Log and nothing else. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'overreach',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'overreach',
  description:
    'A loader fixture: a job that declares only Log and reaches for Facts at runtime.',
  settings: z.object({}),
  jobs: {
    overreach: { trigger: 'action', uses: ['Log'] },
  },
})
