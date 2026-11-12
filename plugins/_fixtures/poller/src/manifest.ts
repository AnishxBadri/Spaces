import { Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/** Two schedule jobs granted Ai: one classifies, one asks for a brief. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'poller',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'Poller',
  description:
    'A loader fixture: schedule jobs granted Ai, one calling classify and one calling synthesize.',
  settings: Schema.Struct({}),
  jobs: {
    classify: {
      trigger: 'schedule',
      schedule: '*/15 * * * *',
      uses: ['Ai', 'Log'],
    },
    brief: {
      trigger: 'schedule',
      schedule: '*/15 * * * *',
      uses: ['Ai', 'Log'],
    },
  },
})
