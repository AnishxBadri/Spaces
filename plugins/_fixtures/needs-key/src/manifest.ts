import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'needs-key',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'needs-key',
  description:
    'A loader fixture (sdk-11): requires a workspace credential, so a row without one degrades.',
  requires: { credential: { kind: 'enrichment', scope: 'workspace' } },
  settings: z.object({}),
  jobs: {
    ping: { trigger: 'action', uses: ['Log'] },
  },
})
