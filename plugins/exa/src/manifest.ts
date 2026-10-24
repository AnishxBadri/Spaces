import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** What one watch holds: its own criteria, and how many companies a run hands on. */
export const watchSettings = z.object({
  criteria: z
    .string()
    .max(1000)
    .default('')
    .describe('Look for — blank uses the space’s criteria'),
  cap: z
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('At most this many companies per run'),
})

/**
 * Exa's manifest. The build emits it as dist/manifest.json with `settings`
 * as JSON Schema.
 * - Neither job names Facts or Identity: a web hit is evidence, never a
 *   field, and Exa never births a record — a found company is a candidate
 *   the host turns into a card.
 * - `Secrets` is in `uses` because each job reads the key from it for the
 *   `x-api-key` header.
 * - Without the workspace `search` key the host degrades the integration,
 *   so the Research action is absent rather than failing when pressed.
 * - `mcp` is Exa's hosted MCP server, which Ask mounts for a turn with the
 *   web in scope: fast search only — websets stay the watch's.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'exa',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Exa',
  roles: ['research'],
  description:
    'Researches a company on the open web through Exa: each page found becomes a web signal on the record, and a short brief citing them waits in Review as a note to accept. Watches a space through an Exa webset: each company found waits in Review as a card under the space, and a page about a company already filed there becomes a web signal on it. Sends Exa the company name and domain, and for a watch the space’s criteria, its nearest memo and its companies’ domains. Finds companies in Ask: with the web in scope a question is searched through Exa’s MCP server, and the companies it finds come back as a table to add or file — Exa is sent the search the question becomes, never from a sensitive scope.',
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
    watch: {
      trigger: 'watch',
      uses: [
        'Config',
        'Secrets',
        'Http',
        'Spaces',
        'Discover',
        'Content',
        'Log',
        'Receipts',
      ],
      settings: watchSettings,
    },
  },
  actions: [
    { id: 'research', label: 'Research', on: 'company', job: 'research' },
  ],
  // A ceiling well under Exa's published search limit; HttpLive also follows
  // the rate-limit headers it answers with.
  http: { rateLimit: { rpm: 60 } },
  mcp: {
    url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa',
    auth: { header: 'x-api-key' },
  },
})
