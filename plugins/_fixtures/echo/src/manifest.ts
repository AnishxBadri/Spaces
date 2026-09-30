import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Authored once, here. The build emits it as dist/manifest.json with
 * `settings` as JSON Schema; nothing else spells it.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'echo',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Echo',
  description:
    'A fixture plugin: an action job that echoes its input, and one that maps a recorded provider payload to claims.',
  settings: z.object({
    greeting: z.string().default('hello'),
    times: z.int().min(1).max(3).default(1),
  }),
  jobs: {
    echo: { trigger: 'action', uses: ['Log'] },
    // Read the domain → ask the provider → resolve → store the receipt →
    // fill (src/map.ts is the pure half: payload in, claims out).
    enrich: {
      trigger: 'action',
      uses: ['Read', 'Http', 'Identity', 'Receipts', 'Facts', 'Log'],
    },
  },
  actions: [
    { id: 'echo', label: 'Echo', on: 'company', job: 'echo' },
    { id: 'enrich', label: 'Enrich (fixture)', on: 'company', job: 'enrich' },
  ],
})
