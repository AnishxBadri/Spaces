import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Research-shaped: read the record, search, draft a brief through Ai, emit a
 * signal per hit and propose the brief as a note citing them. `uses`
 * deliberately lacks Facts and Identity — a signal is evidence, not a fact,
 * and this job never fills or births a record.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'researcher',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Researcher',
  description:
    'A fixture plugin: an action job that searches the web for a company, emits each hit as a signal and proposes a brief.',
  settings: z.object({}),
  jobs: {
    research: {
      trigger: 'action',
      uses: ['Read', 'Http', 'Ai', 'Content', 'Judgment', 'Log'],
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
