import { Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/** Two action jobs on one plugin's queues: one always fails, one never does. */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'throws',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'throws',
  description:
    'A breaker fixture: a job that throws on every run beside one that always succeeds.',
  settings: Schema.Struct({}),
  jobs: {
    boom: { trigger: 'action', uses: ['Log'] },
    fine: { trigger: 'action', uses: ['Log'] },
  },
})
