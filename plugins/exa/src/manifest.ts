import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Exa's manifest. The build emits it as dist/manifest.json with `settings`
 * as JSON Schema.
 * - `research` names no Facts and no Identity: a web hit is evidence, never
 *   a field, and research never births a record.
 * - `Secrets` is in `uses` because the job reads the key from it for the
 *   `x-api-key` header.
 * - Without the workspace `search` key the host degrades the integration,
 *   so the Research action is absent rather than failing when pressed.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'exa',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Exa',
  roles: ['research'],
  description:
    'Researches a company on the open web through Exa: each page found becomes a web signal on the record, and a short brief citing them waits in Review as a note to accept. Sends Exa the company name and domain.',
  requires: { credential: { kind: 'search', scope: 'workspace' } },
  settings: z.object({
    maxResults: z
      .int()
      .min(1)
      .max(25)
      .default(5)
      .describe('Pages to read per research'),
    lookbackDays: z
      .int()
      .min(1)
      .max(3650)
      .default(90)
      .describe('Only pages published within this many days'),
  }),
  jobs: {
    research: {
      trigger: 'action',
      uses: ['Config', 'Secrets', 'Http', 'Read', 'Content', 'Ai', 'Judgment'],
    },
  },
  actions: [
    { id: 'research', label: 'Research', on: 'company', job: 'research' },
  ],
  // A ceiling well under Exa's published search limit; HttpLive also follows
  // the rate-limit headers it answers with.
  http: { rateLimit: { rpm: 60 } },
})
