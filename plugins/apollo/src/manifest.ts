import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/**
 * Apollo's manifest. The build emits it as dist/manifest.json with
 * `settings` as JSON Schema.
 * - `Secrets` is listed in `uses` because a job's `R` is bounded by its
 *   `uses`, and the job reads the key from it for the `X-Api-Key` header.
 * - `cacheDays` and `dailyCreditCap` are the host's to enforce; the
 *   jobs never read them.
 * - No event job: auto-enrich is the host's `enrichment.run`, which presses
 *   these actions in the owner's scope.
 * - `phone` is off by default: asking Apollo for a phone number costs extra
 *   credits, so only the owner turns it on. The person jobs read it through
 *   `Config`.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'apollo',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Apollo',
  roles: ['enrichment'],
  description:
    'Answers company and person fields from Apollo.io: description, founding year, location, LinkedIn, funding stage, headcount and total raised for a company (sent the domain only); job title, LinkedIn, Twitter and the company for a person (sent the email and LinkedIn URL). Adds the domains and verified emails it returns, and logs the latest funding round and a change of role as dated events; every value and event cites the raw response.',
  requires: { credential: { kind: 'enrichment', scope: 'workspace' } },
  settings: z.object({
    cacheDays: z.int().min(0).max(3650).default(90),
    dailyCreditCap: z.int().min(0).default(100),
    phone: z
      .boolean()
      .default(false)
      .describe('Ask for a person’s phone number (extra Apollo credits)'),
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
        'Config',
        'Log',
      ],
    },
  },
  // `answers` is what the host's Enrichment page shows Apollo can fill;
  // `organizationEnrichment` and `personEnrichment` answer no other key.
  actions: [
    {
      id: 'enrich-company',
      label: 'Enrich',
      on: 'company',
      job: 'enrichCompany',
      answers: [
        'company.description',
        'company.founded_year',
        'company.location',
        'company.linkedin',
        'company.funding_stage',
        'company.total_raised',
        'company.headcount',
        'company.revenue',
        'company.industry',
        'company.keywords',
        'company.tech_stack',
        'company.twitter',
        'company.facebook',
        'company.angellist',
        'company.crunchbase',
        'company.blog',
        'company.phone',
        'company.address',
        'company.ticker',
        'company.logo',
      ],
    },
    {
      id: 'enrich-person',
      label: 'Enrich',
      on: 'person',
      job: 'enrichPerson',
      answers: [
        'person.title',
        'person.description',
        'person.location',
        'person.linkedin',
        'person.twitter',
        'person.company',
        'person.seniority',
        'person.department',
        'person.github',
        'person.facebook',
        'person.photo',
        'person.phone',
      ],
    },
  ],
  // Apollo's lowest published per-minute limit; HttpLive also follows the
  // rate-limit headers it answers with.
  http: { rateLimit: { rpm: 50 } },
})
