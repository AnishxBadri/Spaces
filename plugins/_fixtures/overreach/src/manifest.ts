import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** Two action jobs that reach past their grant: one for Facts, one (an enricher) for Ai. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'overreach',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'overreach',
  description:
    'A loader fixture: jobs that reach at runtime for a port their manifest does not grant.',
  settings: z.object({}),
  jobs: {
    overreach: { trigger: 'action', uses: ['Log'] },
    enrich: { trigger: 'action', uses: ['Read', 'Facts', 'Log'] },
  },
})
