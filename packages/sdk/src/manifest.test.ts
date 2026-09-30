import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  manifestSchema,
  settingsJsonSchema,
  toManifestJson,
} from './manifest.ts'
import type { AuthoredManifest } from './manifest.ts'
import { satisfiesSdk } from './range.ts'

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url), 'utf8'),
  )

/** A minimal valid on-disk manifest to vary one field at a time. */
const base = () => {
  const jobs: Record<string, Record<string, unknown>> = {
    enrich: { trigger: 'action', uses: ['Identity', 'Facts'] },
  }
  return {
    manifestVersion: 1,
    id: 'apollo',
    version: '1.2.0',
    sdk: '^1.0',
    name: 'Apollo',
    description: 'Enriches companies and people.',
    settings: { type: 'object', properties: {} },
    jobs,
  }
}

/** Every issue as `path: message`, so a test can name the field it expects. */
const issues = (input: unknown): Array<string> => {
  const result = manifestSchema.safeParse(input)
  return result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

describe('manifestSchema', () => {
  it('accepts the minimal manifest', () => {
    expect(issues(base())).toEqual([])
  })

  it('rejects a manifest that still says kind, naming the field (D51)', () => {
    const found = issues(fixture('legacy-kind.json'))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/^: kind is not a manifest field \(D51\)/)
    console.info(`[sdk] refused legacy-kind.json — ${found[0]}`)
  })

  it('still names any other unknown top-level key', () => {
    expect(issues({ ...base(), colour: 'red' })).toEqual([
      ': Unrecognized key: "colour"',
    ])
  })

  it('parses the too-new fixture, which then fails the sdk check with the loader reason', () => {
    const manifest = manifestSchema.parse(fixture('too-new-sdk.json'))
    const check = satisfiesSdk(manifest.sdk, '1.0.0')
    expect(check).toEqual({
      ok: false,
      reason: 'requires sdk ^2.0, host provides 1.0.0',
    })
    if (!check.ok) console.info(`[sdk] ${manifest.id}: ${check.reason}`)
  })

  describe('id', () => {
    it.each(['Apollo', 'apollo.io', 'core.mailbox', '-apollo', 'apollo-', ''])(
      'rejects %j naming id',
      (id) => {
        const found = issues({ ...base(), id })
        expect(found).toHaveLength(1)
        expect(found[0]).toMatch(/^id: id is lowercase/)
      },
    )

    it.each(['apollo', 'google-drive', 'rss2'])('accepts %j', (id) => {
      expect(issues({ ...base(), id })).toEqual([])
    })
  })

  describe('jobs', () => {
    it('requires a trigger from the five', () => {
      const m = base()
      m.jobs.enrich = { trigger: 'enricher', uses: ['Facts'] }
      expect(issues(m)[0]).toMatch(/^jobs\.enrich\.trigger: /)
      m.jobs.enrich = { uses: ['Facts'] }
      expect(issues(m)[0]).toMatch(/^jobs\.enrich\.trigger: /)
    })

    it('requires a non-empty uses list', () => {
      const m = base()
      m.jobs.enrich = { trigger: 'action', uses: [] }
      expect(issues(m)[0]).toMatch(/^jobs\.enrich\.uses: /)
      m.jobs.enrich = { trigger: 'action' }
      expect(issues(m)[0]).toMatch(/^jobs\.enrich\.uses: /)
    })

    it('requires schedule iff the trigger is schedule', () => {
      const m = base()
      m.jobs.sync = { trigger: 'schedule', uses: ['Http'] }
      expect(issues(m)).toEqual([
        'jobs.sync.schedule: a schedule job needs schedule',
      ])
      m.jobs.sync = {
        trigger: 'schedule',
        uses: ['Http'],
        schedule: '0 * * * *',
      }
      expect(issues(m)).toEqual([])
      m.jobs.enrich = {
        trigger: 'action',
        uses: ['Facts'],
        schedule: '0 * * * *',
      }
      expect(issues(m)).toEqual([
        'jobs.enrich.schedule: schedule is only for a schedule job, and enrich is action',
      ])
    })

    it('requires on iff the trigger is event', () => {
      const m = base()
      m.jobs.onCreate = { trigger: 'event', uses: ['Facts'] }
      expect(issues(m)).toEqual(['jobs.onCreate.on: an event job needs on'])
      m.jobs.onCreate = {
        trigger: 'event',
        uses: ['Facts'],
        on: ['entity.created'],
      }
      expect(issues(m)).toEqual([])
      m.jobs.enrich = {
        trigger: 'action',
        uses: ['Facts'],
        on: ['entity.created'],
      }
      expect(issues(m)).toEqual([
        'jobs.enrich.on: on is only for an event job, and enrich is action',
      ])
    })

    it('refuses a dotted job name — it is the last segment of plugin.<id>.<job>', () => {
      const m = base()
      m.jobs['enrich.people'] = { trigger: 'action', uses: ['Facts'] }
      expect(issues(m)[0]).toMatch(/^jobs\.enrich\.people: a job name is/)
    })
  })

  describe('ingress', () => {
    it('is required when some job is a webhook', () => {
      const m = base()
      m.jobs.push = { trigger: 'webhook', uses: ['Content'] }
      expect(issues(m)).toEqual([
        'ingress: a plugin with a webhook job needs ingress',
      ])
      expect(issues({ ...m, ingress: { signature: 'hmac-sha256' } })).toEqual(
        [],
      )
    })

    it('is refused when no job is a webhook', () => {
      expect(issues({ ...base(), ingress: { signature: 'none' } })).toEqual([
        'ingress: ingress is only for a plugin with a webhook job',
      ])
    })
  })

  describe('actions', () => {
    it('accepts an action naming an action job', () => {
      const m = {
        ...base(),
        actions: [
          { id: 'enrich', label: 'Enrich', on: 'company', job: 'enrich' },
        ],
      }
      expect(issues(m)).toEqual([])
    })

    it('refuses an action naming a job whose trigger is not action', () => {
      const m = base()
      m.jobs.sync = {
        trigger: 'schedule',
        uses: ['Http'],
        schedule: '0 * * * *',
      }
      const found = issues({
        ...m,
        actions: [
          { id: 'sync', label: 'Sync now', on: 'company', job: 'sync' },
        ],
      })
      expect(found).toEqual([
        'actions.0.job: action sync names job sync, whose trigger is schedule, not action',
      ])
    })

    it('refuses an action naming a job the manifest does not declare', () => {
      const found = issues({
        ...base(),
        actions: [
          { id: 'enrich', label: 'Enrich', on: 'person', job: 'enrichh' },
        ],
      })
      expect(found).toEqual([
        'actions.0.job: action enrich names job enrichh, which the manifest does not declare',
      ])
    })
  })

  it('carries the rest of the §3 shape', () => {
    const m = {
      ...base(),
      icon: 'apollo.svg',
      requires: {
        credential: { kind: 'enrichment', scope: 'workspace' },
        connection: { provider: 'google', scopes: ['drive.readonly'] },
      },
      http: { rateLimit: { rpm: 60 } },
      provides: 'storage-source',
      sensitivity: 'inherit',
    }
    m.jobs.enrich = {
      trigger: 'action',
      uses: ['Facts'],
      concurrency: 2,
      timeout: '60s',
      retry: 3,
      interactive: true,
    }
    expect(issues(m)).toEqual([])
  })
})

describe('toManifestJson', () => {
  const authored: AuthoredManifest = {
    manifestVersion: 1,
    id: 'exa',
    version: '0.1.0',
    sdk: '^1.0',
    name: 'Exa',
    description: 'Web research.',
    settings: z.object({
      maxResults: z.int().min(1).max(25).default(5),
      lookbackDays: z.int().optional(),
    }),
    jobs: { research: { trigger: 'action', uses: ['Http', 'Content'] } },
  }

  it('serialises settings to JSON Schema of the operator input', () => {
    const json = toManifestJson(authored)
    expect(json.settings).toEqual(settingsJsonSchema(authored.settings))
    // A field with a default is not required on the form.
    expect(json.settings).not.toHaveProperty('required')
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })

  it('refuses to emit a manifest the loader would refuse', () => {
    expect(() => toManifestJson({ ...authored, id: 'Exa' })).toThrow(
      /id is lowercase/,
    )
  })
})
