import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Apollo's manifest. The build emits it as dist/manifest.json with
 * `settings` as JSON Schema.
 * - `Secrets` is listed in `uses` because a job's `R` is bounded by its
 *   `uses`, and the job reads the key from it for the `X-Api-Key` header.
 * - `cacheDays` and `dailyCreditCap` are the host's to enforce (D53); the
 *   jobs never read them.
 * - `autoEnrich` runs on the triggers D76 names; which of them reach it is
 *   the host's auto-enrich scope on the integration row, never a setting
 *   here. Seed and import births emit nothing. (D65, D76)
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'apollo',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Apollo',
  roles: ['enrichment'],
  description:
    'Fills blank company and person fields from Apollo.io (description, location, founding year, LinkedIn, job title, Twitter), adds the domains and emails it returns, and logs a funding round or a change of title as a signal; every value and signal cites the raw response.',
  requires: { credential: { kind: 'enrichment', scope: 'workspace' } },
  settings: z.object({
    cacheDays: z.int().min(0).max(3650).default(90),
    dailyCreditCap: z.int().min(0).default(100),
  }),
  jobs: {
    enrichCompany: {
      trigger: 'action',
      uses: [
        'Read',
        'Secrets',
        'Http',
        'Identity',
        'Receipts',
        'Facts',
        'Content',
        'Log',
      ],
    },
    enrichPerson: {
      trigger: 'action',
      uses: [
        'Read',
        'Secrets',
        'Http',
        'Identity',
        'Receipts',
        'Facts',
        'Content',
        'Log',
      ],
    },
    autoEnrich: {
      trigger: 'event',
      on: ['entity.created', 'filed', 'deal.linked'],
      uses: [
        'Read',
        'Secrets',
        'Http',
        'Identity',
        'Receipts',
        'Facts',
        'Content',
        'Log',
      ],
    },
  },
  actions: [
    {
      id: 'enrich-company',
      label: 'Enrich',
      on: 'company',
      job: 'enrichCompany',
    },
    { id: 'enrich-person', label: 'Enrich', on: 'person', job: 'enrichPerson' },
  ],
  // Apollo's lowest published per-minute limit; HttpLive also follows the
  // rate-limit headers it answers with.
  http: { rateLimit: { rpm: 50 } },
})
