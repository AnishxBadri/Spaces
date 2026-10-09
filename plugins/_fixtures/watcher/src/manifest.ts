import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** What one watch holds: how far it may go, and whether to fail on purpose. */
export const lensSettings = z.object({
  cap: z.int().min(1).max(100).default(10),
  fail: z.boolean().default(false),
})

/** One watch job granted Spaces and Log. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'watcher',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Watcher',
  description:
    'A loader fixture: a watch job that reads its space brief, logs it and keeps a run count as its state.',
  settings: z.object({}),
  jobs: {
    lens: {
      trigger: 'watch',
      uses: ['Spaces', 'Log'],
      settings: lensSettings,
    },
  },
})
