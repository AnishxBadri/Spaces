import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Research-shaped (sdk-7b): read the record, search, emit a signal per hit.
 * `uses` deliberately lacks Facts and Identity — a signal is evidence, not a
 * fact, and this job never fills or births a record.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'researcher',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Researcher',
  description:
    'A fixture plugin: an action job that searches the web for a company and emits each hit as a signal.',
  settings: z.object({}),
  jobs: {
    research: {
      trigger: 'action',
      uses: ['Read', 'Http', 'Content', 'Log'],
    },
  },
  actions: [
    {
      id: 'research',
      label: 'Research (fixture)',
      on: 'company',
      job: 'research',
    },
  ],
})
