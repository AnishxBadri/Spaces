import { Effect } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { Client } from 'pg'
import type { Notification } from 'pg'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  credential,
  enrichmentRecord,
  entity,
  integration,
} from '@spaces/db/schema'
import type { IntegrationManifest } from '@spaces/db/schema'
import { resolveSecretById } from '@spaces/core/writes/vault'
import { settingsJsonSchema } from '@spaces/sdk'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { recordActionsProgram } from './actions'
import {
  MISSING_CREDENTIAL,
  PLUGIN_CHANGED,
  countIntegrationsHandler,
  getIntegrationHandler,
  listIntegrationsHandler,
  removeIntegrationSecretHandler,
  resetIntegrationHandler,
  saveIntegrationSecretHandler,
  saveIntegrationSettingsHandler,
  setIntegrationEnabledHandler,
} from './admin'
import { agoOf, latestRunOf } from './ledger'

/**
 * Settings → Integrations against a real database: the ledger reads every
 * plugin row with its state, last run and credits from the row and
 * enrichment_record (a run is `runJob`'s alone to write, so the job_run half
 * is `latestRunOf`, tested pure); every write is admin-only and NOTIFYs `plugin_changed`
 * with the plugin id. Rows are seeded with a stored manifest the way the
 * loader leaves them — no plugin code runs. The request is stubbed; the
 * session, `requireAdmin`, the vault and the database are real.
 */

const session: { current: { id: string; role: string } | null } = {
  current: null,
}

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('http://localhost/settings/integrations'),
}))

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

const asAdmin = () => {
  session.current = { id: FIXTURE_ACTOR.id, role: 'admin' }
}

/** Apollo's manifest as the loader stores it, settings emitted by the sdk. */
const APOLLO: IntegrationManifest = {
  manifestVersion: 1,
  id: 'apollo',
  version: '0.1.0',
  sdk: '^1.0',
  name: 'Apollo',
  description: 'Fills blank company and person fields from Apollo.io.',
  requires: { credential: { kind: 'enrichment', scope: 'workspace' } },
  settings: JSON.parse(
    JSON.stringify(
      settingsJsonSchema(
        z.object({
          cacheDays: z.int().min(0).max(3650).default(90),
          dailyCreditCap: z.int().min(0).default(100),
          autoEnrich: z.boolean().default(false),
        }),
      ),
    ),
  ),
  jobs: { enrichCompany: { trigger: 'action', uses: ['Read', 'Secrets'] } },
  actions: [
    {
      id: 'enrich-company',
      label: 'Enrich',
      on: 'company',
      job: 'enrichCompany',
    },
  ],
}

const fixture = (id: string, sdk = '^1.0'): IntegrationManifest => ({
  manifestVersion: 1,
  id,
  version: '0.1.0',
  sdk,
  name: id,
  description: `The ${id} loader fixture.`,
  settings: {},
  jobs: { ping: { trigger: 'action', uses: ['Log'] } },
})

type Seed = Partial<typeof integration.$inferInsert> & {
  manifest: IntegrationManifest | null
}

const install = async (seed: Seed) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: String(seed.manifest?.id ?? 'unknown'),
        version: '0.1.0',
        enabled: true,
        status: 'enabled',
        ...seed,
      })
      .returning()
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row
}

const rowOf = async (id: string) => {
  const row = (
    await db.select().from(integration).where(eq(integration.id, id))
  ).at(0)
  if (!row) throw new Error(`no integration ${id}`)
  return row
}

const company = async () => {
  const row = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: 'Ohmium' })
      .returning({ id: entity.id })
  ).at(0)
  if (!row) throw new Error('no entity')
  return row.id
}

const companyActions = () =>
  Effect.runPromise(recordActionsProgram('company')).then((a) =>
    a.map((x) => x.pluginId),
  )

// A LISTEN on this worker's database: what the worker would hear.
const heard: Array<string> = []
let listener: Client

beforeAll(async () => {
  listener = new Client({ connectionString: process.env.DATABASE_URL })
  await listener.connect()
  listener.on('notification', (m: Notification) => {
    if (m.channel === PLUGIN_CHANGED) heard.push(m.payload ?? '')
  })
  await listener.query(`LISTEN ${PLUGIN_CHANGED}`)
})

afterAll(async () => {
  await listener.end()
})

/** Notifications arrive after the commit, on the listener's own connection. */
const heardSoon = async (expected: ReadonlyArray<string>) => {
  // Silence is only proved by waiting for a notification that never comes.
  if (expected.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 150))
  for (let i = 0; i < 50 && heard.length < expected.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  expect(heard).toEqual(expected)
}

beforeEach(async () => {
  heard.length = 0
  session.current = null
  // Every row of these tables, between tests; the file-level truncate runs once per file.
  const all = sql`true`
  await db.delete(enrichmentRecord).where(all)
  await db.update(integration).set({ credentialId: null }).where(all)
  await db.delete(integration).where(all)
  await db.delete(credential).where(all)
})

describe('every handler refuses a non-admin', () => {
  it.each([
    ['a member', { id: FIXTURE_ACTOR.id, role: 'member' }],
    ['nobody', null],
  ])('%s is refused before anything is read or written', async (_, who) => {
    const apollo = await install({ manifest: APOLLO, credentialId: null })
    session.current = who
    const refused = who === null ? 'Unauthorized' : 'Admins only'
    await expect(listIntegrationsHandler()).rejects.toThrow(refused)
    await expect(countIntegrationsHandler()).rejects.toThrow(refused)
    await expect(getIntegrationHandler({ id: apollo.id })).rejects.toThrow(
      refused,
    )
    await expect(
      setIntegrationEnabledHandler({ id: apollo.id, enabled: false }),
    ).rejects.toThrow(refused)
    await expect(resetIntegrationHandler({ id: apollo.id })).rejects.toThrow(
      refused,
    )
    await expect(
      saveIntegrationSettingsHandler({
        id: apollo.id,
        values: { cacheDays: '1' },
      }),
    ).rejects.toThrow(refused)
    await expect(
      saveIntegrationSecretHandler({
        id: apollo.id,
        slot: 'credential',
        secret: 'k',
      }),
    ).rejects.toThrow(refused)
    await expect(
      removeIntegrationSecretHandler({ id: apollo.id, slot: 'credential' }),
    ).rejects.toThrow(refused)
    expect(await rowOf(apollo.id)).toMatchObject({
      enabled: true,
      config: {},
      credentialId: null,
    })
    expect(await db.select().from(credential)).toEqual([])
    await heardSoon([])
  })
})

describe('the ledger', () => {
  it('lists every plugin row with version, state, last run, last error and credits — never a core.* channel', async () => {
    asAdmin()
    // Apollo with a key, a run four minutes ago and 12 credits today.
    const stored = await db
      .insert(credential)
      .values({
        scope: 'workspace',
        provider: 'apollo',
        kind: 'enrichment',
        secretEnc: Buffer.from('x'),
        meta: { display: 'sk-…9f3c' },
        createdBy: FIXTURE_ACTOR.id,
      })
      .returning({ id: credential.id })
    const apollo = await install({
      manifest: APOLLO,
      credentialId: stored.at(0)?.id ?? null,
      config: { dailyCreditCap: 40 },
      lastRunAt: new Date(Date.now() - 4 * 60_000),
    })
    const ohmium = await company()
    await db.insert(enrichmentRecord).values([
      {
        entityId: ohmium,
        provider: 'apollo',
        raw: {},
        creditsUsed: 7,
        integrationId: apollo.id,
      },
      {
        entityId: ohmium,
        provider: 'apollo',
        raw: {},
        creditsUsed: 5,
        integrationId: apollo.id,
      },
    ])
    // The throws fixture, tripped by the breaker.
    await install({
      manifest: fixture('throws'),
      status: 'disabled',
      errorCount: 5,
      lastError: '5 failures in an hour',
    })
    // The old-sdk fixture, degraded by the loader with the manifest it read.
    await install({
      manifest: fixture('old-sdk', '^2.0'),
      status: 'degraded',
      lastError: 'requires sdk ^2.0, host provides 1.1.0',
    })
    // A plugin whose key is not pasted yet, and one the operator turned off.
    await install({
      capabilityId: 'apollo-eu',
      manifest: { ...APOLLO, id: 'apollo-eu', name: 'Apollo EU' },
      status: 'degraded',
      lastError: MISSING_CREDENTIAL,
    })
    await install({ manifest: fixture('echo'), enabled: false })
    await install({ capabilityId: 'core.mailbox', manifest: null })

    const rows = await listIntegrationsHandler()
    expect(rows.map((r) => [r.pluginId, r.state])).toEqual([
      ['apollo', 'enabled'],
      ['apollo-eu', 'needs-key'],
      ['echo', 'off'],
      ['old-sdk', 'degraded'],
      ['throws', 'tripped'],
    ])
    expect(rows[0]).toMatchObject({
      name: 'Apollo',
      version: '0.1.0',
      reason: null,
      summary: APOLLO.description,
      lastRun: { ago: '4m ago', failed: false },
      credits: { used: 12, cap: 40 },
    })
    // The manifest's declared cap when the config sets none.
    expect(rows[1].credits).toEqual({ used: 0, cap: 100 })
    expect(rows[3]).toMatchObject({
      reason: 'requires sdk ^2.0, host provides 1.1.0',
      lastRun: null,
    })
    expect(rows[4]).toMatchObject({
      reason: '5 failures in an hour',
      errorCount: 5,
    })
    expect(await countIntegrationsHandler()).toBe(5)
  })

  it('names the version fix for a plugin built against an sdk this host does not provide', async () => {
    asAdmin()
    const old = await install({
      manifest: fixture('old-sdk', '^2.0'),
      status: 'degraded',
      lastError: 'requires sdk ^2.0, host provides 1.1.0',
    })
    const detail = await getIntegrationHandler({ id: old.id })
    expect(detail.fix).toContain('^2.0')
    expect(detail.form).toEqual({ ok: true, fields: [] })
  })

  it('reads the last run from the latest job_run or the row, whichever is later', () => {
    const now = Date.parse('2026-10-06T12:00:00Z')
    const run = {
      startedAt: new Date(now - 4 * 60_000),
      status: 'failed' as const,
      summary: '6 fields filled on Ohmium',
    }
    expect(latestRunOf(run, null, now)).toEqual({
      summary: '6 fields filled on Ohmium',
      lastRun: { ago: '4m ago', failed: true },
    })
    expect(
      latestRunOf(
        { ...run, status: 'succeeded' },
        new Date(now - 2 * 3_600_000),
        now,
      ),
    ).toEqual({
      summary: '6 fields filled on Ohmium',
      lastRun: { ago: '4m ago', failed: false },
    })
    expect(latestRunOf(undefined, null, now)).toEqual({
      summary: null,
      lastRun: null,
    })
  })

  it('agoOf reads minutes, hours, days', () => {
    expect(agoOf(20_000)).toBe('just now')
    expect(agoOf(4 * 60_000)).toBe('4m ago')
    expect(agoOf(2 * 3_600_000)).toBe('2h ago')
    expect(agoOf(72 * 3_600_000)).toBe('3d ago')
  })
})

describe('on, off and reset', () => {
  it('turning a plugin off keeps its row and key, takes its record actions away and reloads it', async () => {
    asAdmin()
    const apollo = await install({ manifest: APOLLO })
    expect(await companyActions()).toEqual(['apollo'])

    await setIntegrationEnabledHandler({ id: apollo.id, enabled: false })
    expect((await rowOf(apollo.id)).enabled).toBe(false)
    expect(await companyActions()).toEqual([])
    expect((await listIntegrationsHandler()).at(0)?.state).toBe('off')

    await setIntegrationEnabledHandler({ id: apollo.id, enabled: true })
    expect(await companyActions()).toEqual(['apollo'])
    await heardSoon(['apollo', 'apollo'])
  })

  it('reset clears a tripped breaker: error_count to 0, status restored, and a reload', async () => {
    asAdmin()
    const throws = await install({
      manifest: fixture('throws'),
      status: 'disabled',
      errorCount: 5,
      lastError: '5 failures in an hour',
    })
    await resetIntegrationHandler({ id: throws.id })
    expect(await rowOf(throws.id)).toMatchObject({
      enabled: true,
      status: 'enabled',
      errorCount: 0,
      lastError: null,
    })
    await heardSoon(['throws'])
  })

  it('reset refuses a plugin the breaker did not stop', async () => {
    asAdmin()
    const echo = await install({ manifest: fixture('echo') })
    await expect(resetIntegrationHandler({ id: echo.id })).rejects.toThrow(
      'echo is not stopped by the breaker',
    )
    await heardSoon([])
  })
})

describe('the settings form', () => {
  it('prefills from the stored config, not an empty one', async () => {
    asAdmin()
    const apollo = await install({
      manifest: APOLLO,
      config: { cacheDays: 30, seeded: ['kept'] },
    })
    const detail = await getIntegrationHandler({ id: apollo.id })
    expect(detail.form.ok).toBe(true)
    expect(detail.values).toEqual({
      cacheDays: '30',
      dailyCreditCap: '100',
      autoEnrich: false,
    })
  })

  it('a value failing the schema comes back against its field and nothing is written', async () => {
    asAdmin()
    const apollo = await install({
      manifest: APOLLO,
      config: { cacheDays: 90 },
    })
    expect(
      await saveIntegrationSettingsHandler({
        id: apollo.id,
        values: { cacheDays: '-3', dailyCreditCap: '100', autoEnrich: false },
      }),
    ).toEqual({
      ok: false,
      errors: { cacheDays: 'must be between 0 and 3650' },
    })
    expect((await rowOf(apollo.id)).config).toEqual({ cacheDays: 90 })
    expect((await rowOf(apollo.id)).status).toBe('enabled')
    await heardSoon([])
  })

  it('a good save writes integration.config, keeps keys the form does not draw, and reloads', async () => {
    asAdmin()
    const apollo = await install({
      manifest: APOLLO,
      config: { cacheDays: 90, seeded: ['kept'] },
    })
    expect(
      await saveIntegrationSettingsHandler({
        id: apollo.id,
        values: { cacheDays: '30', dailyCreditCap: '', autoEnrich: true },
      }),
    ).toEqual({ ok: true })
    expect((await rowOf(apollo.id)).config).toEqual({
      cacheDays: 30,
      seeded: ['kept'],
      autoEnrich: true,
    })
    await heardSoon(['apollo'])
  })

  it('refuses to save against a manifest whose settings the form cannot draw', async () => {
    asAdmin()
    const feeds = await install({
      manifest: {
        ...fixture('feeds'),
        settings: { type: 'object', properties: { urls: { type: 'array' } } },
      },
    })
    const detail = await getIntegrationHandler({ id: feeds.id })
    expect(detail.form.ok).toBe(false)
    await expect(
      saveIntegrationSettingsHandler({ id: feeds.id, values: {} }),
    ).rejects.toThrow('setting urls is an array')
  })
})

describe('the key field', () => {
  const SECRET = 'apollo-live-key-0123456789-9f3c'

  it('stores the key workspace-scoped under the plugin id, binds it, shows it redacted, and reloads', async () => {
    asAdmin()
    const apollo = await install({
      manifest: APOLLO,
      status: 'degraded',
      lastError: MISSING_CREDENTIAL,
    })
    expect((await getIntegrationHandler({ id: apollo.id })).secrets).toEqual([
      { slot: 'credential', label: 'Apollo key', display: null },
    ])

    const saved = await saveIntegrationSecretHandler({
      id: apollo.id,
      slot: 'credential',
      secret: `  ${SECRET} `,
    })
    expect(saved).toEqual({ display: 'apo…9f3c' })

    const rows = await db.select().from(credential)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      scope: 'workspace',
      provider: 'apollo',
      kind: 'enrichment',
      userId: null,
      meta: { display: 'apo…9f3c', slot: 'credential' },
    })
    expect(await resolveSecretById(rows[0].id)).toBe(SECRET)
    expect((await rowOf(apollo.id)).credentialId).toBe(rows[0].id)
    await heardSoon(['apollo'])

    // The worker flips the status on its reload; until then the row reads its own state.
    const detail = await getIntegrationHandler({ id: apollo.id })
    expect(detail.secrets).toEqual([
      { slot: 'credential', label: 'Apollo key', display: 'apo…9f3c' },
    ])
    expect(JSON.stringify(detail)).not.toContain(SECRET)
    expect(JSON.stringify(await listIntegrationsHandler())).not.toContain(
      SECRET,
    )
  })

  it('a second paste replaces the key in place', async () => {
    asAdmin()
    const apollo = await install({ manifest: APOLLO })
    await saveIntegrationSecretHandler({
      id: apollo.id,
      slot: 'credential',
      secret: SECRET,
    })
    await saveIntegrationSecretHandler({
      id: apollo.id,
      slot: 'credential',
      secret: 'second-key-abcdefgh',
    })
    const rows = await db.select().from(credential)
    expect(rows).toHaveLength(1)
    expect(await resolveSecretById(rows[0].id)).toBe('second-key-abcdefgh')
  })

  it('removing the key returns the row to degraded(missing credential), deletes it and takes the actions away', async () => {
    asAdmin()
    const apollo = await install({ manifest: APOLLO })
    await saveIntegrationSecretHandler({
      id: apollo.id,
      slot: 'credential',
      secret: SECRET,
    })
    expect(await companyActions()).toEqual(['apollo'])

    await removeIntegrationSecretHandler({ id: apollo.id, slot: 'credential' })
    expect(await rowOf(apollo.id)).toMatchObject({
      credentialId: null,
      status: 'degraded',
      lastError: MISSING_CREDENTIAL,
    })
    expect(await db.select().from(credential)).toEqual([])
    expect(await companyActions()).toEqual([])
    expect((await listIntegrationsHandler()).at(0)?.state).toBe('needs-key')
    await heardSoon(['apollo', 'apollo'])
  })

  it('a plugin that requires no key refuses one', async () => {
    asAdmin()
    const echo = await install({ manifest: fixture('echo') })
    await expect(
      saveIntegrationSecretHandler({
        id: echo.id,
        slot: 'credential',
        secret: SECRET,
      }),
    ).rejects.toThrow('echo does not take a key')
    expect(await db.select().from(credential)).toEqual([])
  })
})
