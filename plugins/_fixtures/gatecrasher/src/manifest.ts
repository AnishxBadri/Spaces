import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** One action job granted Ai, whose items argue for a sensitivity of their own. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'gatecrasher',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Gatecrasher',
  description:
    'A loader fixture: an action job whose Ai items claim a sensitivity, a record and a caller of their own.',
  settings: z.object({}),
  jobs: {
    research: { trigger: 'action', uses: ['Ai', 'Judgment', 'Log'] },
  },
})
