import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Apollo's manifest. The build emits it as dist/manifest.json with
 * `settings` as JSON Schema.
 * - `Secrets` is listed in `uses` because a job's `R` is bounded by its
 *   `uses`, and the job reads the key from it for the `X-Api-Key` header.
 * - `cacheDays` and `dailyCreditCap` are the host's to enforce (D53); the
 *   jobs never read them.
 * - `autoEnrich` is the dispatcher's switch for `onCompanyCreated`: off, a
 *   new company enqueues nothing. Never in bulk — seed and import births
 *   emit no event. (D65)
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'apollo',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Apollo',
  description:
    'Fills blank company and person fields from Apollo.io (description, location, founding year, LinkedIn, job title) and adds the domains, emails and LinkedIn pages it returns; every value cites the raw response.',
  requires: { credential: { kind: 'enrichment', scope: 'workspace' } },
  settings: z.object({
    cacheDays: z.int().min(0).max(3650).default(90),
    dailyCreditCap: z.int().min(0).default(100),
    autoEnrich: z.boolean().default(false),
  }),
  jobs: {
    enrichCompany: {
      trigger: 'action',
      uses: ['Read', 'Secrets', 'Http', 'Identity', 'Receipts', 'Facts', 'Log'],
    },
    enrichPerson: {
      trigger: 'action',
      uses: ['Read', 'Secrets', 'Http', 'Identity', 'Receipts', 'Facts', 'Log'],
    },
    onCompanyCreated: {
      trigger: 'event',
      on: ['entity.created'],
      uses: ['Read', 'Secrets', 'Http', 'Identity', 'Receipts', 'Facts', 'Log'],
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
