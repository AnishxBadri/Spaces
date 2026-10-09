import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DOMAIN_EVENTS, PORT_NAMES } from './contract.ts'
import {
  ROLES,
  STORAGE_SOURCE_WITHHELD,
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

  describe('roles', () => {
    it('is optional: a manifest without it loads', () => {
      expect(manifestSchema.parse(base())).not.toHaveProperty('roles')
    })

    it('takes any of the seven jobs the catalogue groups by (D81)', () => {
      expect(ROLES).toEqual([
        'enrichment',
        'research',
        'email-calendar',
        'files',
        'meeting-notes',
        'import',
        'feeds',
      ])
      expect(issues({ ...base(), roles: ['research', 'enrichment'] })).toEqual(
        [],
      )
    })

    it('refuses an unknown role, naming it', () => {
      expect(issues({ ...base(), roles: ['crm'] })).toEqual([
        `roles.0: unknown role "crm" — roles name jobs from ROLES (${ROLES.join(', ')})`,
      ])
    })

    it('refuses an empty list and a repeated role', () => {
      expect(issues({ ...base(), roles: [] })).toHaveLength(1)
      expect(issues({ ...base(), roles: ['feeds', 'feeds'] })).toEqual([
        'roles: roles names each role once',
      ])
    })
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

    it('refuses a port that is not in PORT_NAMES, naming it', () => {
      const m = base()
      m.jobs.enrich = { trigger: 'action', uses: ['Identity', 'Clock'] }
      const found = issues(m)
      expect(found).toHaveLength(1)
      expect(found[0]).toMatch(/^jobs\.enrich\.uses\.1: unknown port "Clock"/)
    })

    it('refuses an event that is not in DOMAIN_EVENTS, naming it', () => {
      const m = base()
      m.jobs.onUpdate = {
        trigger: 'event',
        uses: ['Facts'],
        on: ['entity.updated'],
      }
      expect(issues(m)[0]).toMatch(
        /^jobs\.onUpdate\.on\.0: unknown event "entity\.updated"/,
      )
    })

    it('takes filed and deal.linked beside entity.created (SDK 1.2)', () => {
      expect(DOMAIN_EVENTS).toEqual(['entity.created', 'filed', 'deal.linked'])
      const m = base()
      m.jobs.onFiled = { trigger: 'event', uses: ['Facts'], on: ['filed'] }
      m.jobs.onLinked = {
        trigger: 'event',
        uses: ['Facts'],
        on: ['deal.linked', 'entity.created'],
      }
      expect(issues(m)).toEqual([])
    })

    it('takes accepts on a file job only, as a pattern that compiles', () => {
      const m = base()
      m.jobs.read = {
        trigger: 'file',
        uses: ['Import'],
        accepts: { filename: '-[^/]* view\\.csv$' },
      }
      expect(issues(m)).toEqual([])
      m.jobs.read = {
        trigger: 'file',
        uses: ['Import'],
        accepts: { filename: '([' },
      }
      expect(issues(m)).toEqual([
        'jobs.read.accepts.filename: accepts.filename is a regular expression',
      ])
      m.jobs.read = {
        trigger: 'action',
        uses: ['Import'],
        accepts: { filename: 'x' },
      }
      expect(issues(m)).toEqual([
        'jobs.read.accepts: accepts is only for a file job, and read is action',
      ])
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

  describe('provides storage-source', () => {
    // The port-grant table (docs/spec-plugin-sdk.md §4): a storage-source
    // provider never fills facts and never calls Ai; every other port in
    // PORT_NAMES stays grantable.
    const storageSource = (uses: Array<string>) => {
      const m = { ...base(), provides: 'storage-source' }
      m.jobs = { sync: { trigger: 'schedule', schedule: '*/5 * * * *', uses } }
      return m
    }

    it('withholds exactly Facts and Ai', () => {
      expect([...STORAGE_SOURCE_WITHHELD].sort()).toEqual(['Ai', 'Facts'])
    })

    const granted = PORT_NAMES.filter(
      (p) => !STORAGE_SOURCE_WITHHELD.some((w) => w === p),
    )

    it.each(granted)('grants %s', (port) => {
      expect(issues(storageSource([port]))).toEqual([])
    })

    it.each([...STORAGE_SOURCE_WITHHELD])(
      'refuses a job that uses %s, naming the rule',
      (port) => {
        const found = issues(storageSource(['Http', port]))
        expect(found).toEqual([
          `jobs.sync.uses.1: a storage-source plugin is granted no Facts and no Ai port — it delivers bytes and never decides filing or calls Ai, and sync uses ${port}`,
        ])
      },
    )

    it('leaves Facts and Ai to a plugin that provides nothing', () => {
      const m = storageSource(['Facts', 'Ai'])
      expect(issues({ ...m, provides: undefined })).toEqual([])
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
      uses: ['Content'],
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
