import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Effect, Exit } from 'effect'
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
import { db } from '@spaces/db'
import { entity, integration } from '@spaces/db/schema'
import { setValues } from '@spaces/core/writes/attributes/values'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { fixturePlugin, fixtureSigner } from '@spaces/core/plugins/fixtures'
import type { FixturePlugin } from '@spaces/core/plugins/fixtures'
import type { PluginRole } from '@spaces/sdk'
import { PLUGIN_CHANGED } from '@spaces/core/writes/plugins/install'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { recordTimelineProgram } from '../timeline/record'
import {
  availableProgram,
  installFromRegistryProgram,
  installFromUploadProgram,
  installIntegrationHandler,
  listAvailableHandler,
  uninstallIntegrationHandler,
  uninstallIntegrationProgram,
  upgradeFromRegistryProgram,
  upgradeIntegrationHandler,
  uploadIntegrationHandler,
} from './install'
import { integrationLedgerProgram } from './ledger'
import type { RegistrySource } from './registry'

/**
 * Install from the running deployment, through the programs the server fns
 * call: a registry.json and its signed tarballs on disk (`file:` URLs, never
 * the network), a scratch data directory, and the real database. No plugin
 * code runs — the worker's half is `apps/worker`'s install-live test.
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

const signer = fixtureSigner()
const heard: Array<string> = []
let listener: Client

beforeAll(async () => {
  listener = new Client({ connectionString: process.env.DATABASE_URL })
  await listener.connect()
  listener.on('notification', (m: Notification) => {
    if (m.channel === PLUGIN_CHANGED) heard.push(m.payload ?? '')
  })
  await listener.query(`listen ${PLUGIN_CHANGED}`)
})

afterAll(async () => {
  await listener.end()
})

let served: string
let source: RegistrySource & { registryFile: string; dataDir: string }
const plugins = () => path.join(source.dataDir, 'plugins')

beforeEach(async () => {
  await db.execute(sql`truncate integration cascade`)
  heard.length = 0
  session.current = null
  served = mkdtempSync(path.join(tmpdir(), 'spaces-registry-'))
  const keysDir = path.join(served, 'plugin-keys')
  mkdirSync(keysDir)
  signer.trustIn(keysDir)
  source = {
    registryFile: path.join(served, 'registry.json'),
    keysDir,
    dataDir: mkdtempSync(path.join(tmpdir(), 'spaces-data-')),
  }
})

/** Writes the tarballs beside a registry.json naming them by `file:` URL. */
const serve = (...entries: Array<FixturePlugin>) => {
  const registry = entries.map(({ tarball, entry }) => {
    const file = path.join(served, `${entry.id}-${entry.version}.tgz`)
    writeFileSync(file, tarball)
    return { ...entry, tarball: pathToFileURL(file).href }
  })
  writeFileSync(source.registryFile, JSON.stringify(registry))
}

const echo = (version: string) =>
  fixturePlugin({
    id: 'echo',
    version,
    signer,
    requires: { credential: { kind: 'enrichment', scope: 'workspace' } },
    manifest: { name: 'Echo' },
  })

const run = <TValue, TError>(program: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(program)

const failureOf = async <TValue, TError>(
  program: Effect.Effect<TValue, TError>,
): Promise<TError> => {
  const exit = await Effect.runPromiseExit(program)
  if (Exit.isSuccess(exit)) throw new Error('expected a refusal')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

const heardSoon = async (pluginId: string) => {
  for (let i = 0; i < 50 && !heard.includes(pluginId); i++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  expect(heard).toContain(pluginId)
}

const rows = () =>
  db.select().from(integration).where(eq(integration.capabilityId, 'echo'))

describe('the Available pane', () => {
  it('offers the newest version of each plugin not installed, with what it will ask for', async () => {
    serve(
      echo('1.0.0'),
      echo('1.2.0'),
      fixturePlugin({ id: 'rss', version: '0.1.0', signer }),
    )
    expect(await run(availableProgram(source))).toEqual({
      available: [
        {
          pluginId: 'echo',
          name: 'Echo',
          description: 'The echo fixture.',
          version: '1.2.0',
          roles: [],
          needs: 'Echo key',
        },
        {
          pluginId: 'rss',
          name: 'Rss',
          description: 'The rss fixture.',
          version: '0.1.0',
          roles: [],
          needs: 'no key',
        },
      ],
      error: null,
    })

    await run(installFromRegistryProgram(FIXTURE_ACTOR.id, 'rss', source))
    expect(
      (await run(availableProgram(source))).available.map((a) => a.pluginId),
    ).toEqual(['echo'])
  })

  it('carries each entry roles for the tabs, none for an entry without them', async () => {
    const roled = (id: string, roles: Array<PluginRole>): FixturePlugin => {
      const plugin = fixturePlugin({
        id,
        version: '0.1.0',
        signer,
        manifest: { roles },
      })
      return { ...plugin, entry: { ...plugin.entry, roles } }
    }
    serve(
      roled('airtable', ['import']),
      roled('rss', ['feeds']),
      fixturePlugin({ id: 'legacy', version: '0.1.0', signer }),
    )
    const view = await run(availableProgram(source))
    expect(view.available.map((a) => [a.pluginId, a.roles])).toEqual([
      ['airtable', ['import']],
      ['rss', ['feeds']],
      ['legacy', []],
    ])

    // Install runs the existing installer; the plugin leaves Available.
    await run(installFromRegistryProgram(FIXTURE_ACTOR.id, 'airtable', source))
    expect(
      (await run(availableProgram(source))).available.map((a) => a.pluginId),
    ).toEqual(['rss', 'legacy'])
  })

  it('says why when the registry cannot be read', async () => {
    writeFileSync(source.registryFile, '[{"id":"echo"}]')
    const view = await run(availableProgram(source))
    expect(view.available).toEqual([])
    expect(view.error).toContain('is invalid')
  })
})

describe('install from the registry', () => {
  it('fetches, verifies and unpacks the tarball, pins lock.json, writes the row and notifies', async () => {
    serve(echo('1.0.0'))
    const outcome = await run(
      installFromRegistryProgram(FIXTURE_ACTOR.id, 'echo', source),
    )
    expect(outcome).toEqual({ name: 'Echo', version: '1.0.0', warning: null })

    const dir = path.join(plugins(), 'echo')
    expect(readdirSync(path.join(dir, '1.0.0')).sort()).toEqual([
      'bundle.mjs',
      'manifest.json',
    ])
    expect(readlinkSync(path.join(dir, 'current'))).toBe('1.0.0')
    expect(
      JSON.parse(readFileSync(path.join(plugins(), 'lock.json'), 'utf8')),
    ).toMatchObject({ plugins: { echo: { version: '1.0.0' } } })
    expect(await rows()).toMatchObject([
      { version: '1.0.0', enabled: true, status: 'installing' },
    ])
    await heardSoon('echo')

    // The ledger reads it at once: installed, waiting on its key.
    const ledger = await run(integrationLedgerProgram(source))
    expect(ledger.map((r) => [r.pluginId, r.state, r.update])).toEqual([
      ['echo', 'needs-key', null],
    ])
  })

  it('refuses a tampered tarball and leaves the data directory untouched', async () => {
    const good = echo('1.0.0')
    const tampered = Uint8Array.from(good.tarball)
    tampered[40] = (tampered.at(40) ?? 0) ^ 0xff
    serve({ ...good, tarball: tampered })

    const refused = await failureOf(
      installFromRegistryProgram(FIXTURE_ACTOR.id, 'echo', source),
    )
    expect(refused.message).toContain('Refused (sha-mismatch)')
    expect(existsSync(plugins())).toBe(false)
    expect(await rows()).toEqual([])
    expect(heard).toEqual([])
  })
})

describe('install from an upload', () => {
  /** The two files a release publishes, as the form hands them over. */
  const uploadOf = (p: FixturePlugin) => ({
    tarballName: `${p.entry.id}-${p.entry.version}.tgz`,
    tarball: p.tarball,
    entryText: JSON.stringify(p.entry),
  })

  it('installs the .tgz and its .json entry exactly as a registry install does', async () => {
    const outcome = await run(
      installFromUploadProgram(
        FIXTURE_ACTOR.id,
        uploadOf(echo('1.0.0')),
        source,
      ),
    )
    expect(outcome).toEqual({ name: 'Echo', version: '1.0.0', warning: null })
    expect(readlinkSync(path.join(plugins(), 'echo', 'current'))).toBe('1.0.0')
    expect(
      JSON.parse(readFileSync(path.join(plugins(), 'lock.json'), 'utf8')),
    ).toMatchObject({ plugins: { echo: { version: '1.0.0' } } })
    expect(await rows()).toMatchObject([
      {
        version: '1.0.0',
        enabled: true,
        status: 'installing',
        createdBy: FIXTURE_ACTOR.id,
      },
    ])
    await heardSoon('echo')
  })

  const tampered = (p: FixturePlugin): FixturePlugin => {
    const bytes = Uint8Array.from(p.tarball)
    bytes[40] = (bytes.at(40) ?? 0) ^ 0xff
    return { ...p, tarball: bytes }
  }
  const untrusted = () =>
    fixturePlugin({ id: 'echo', version: '1.0.0', signer: fixtureSigner() })

  it.each([
    ['sha-mismatch', () => tampered(echo('1.0.0'))],
    ['unknown-key', untrusted],
  ])(
    'refuses a %s upload with the reason the registry path gives, writing nothing',
    async (code, make) => {
      const plugin = make()
      serve(plugin)
      const viaRegistry = await failureOf(
        installFromRegistryProgram(FIXTURE_ACTOR.id, 'echo', source),
      )
      const viaUpload = await failureOf(
        installFromUploadProgram(FIXTURE_ACTOR.id, uploadOf(plugin), source),
      )
      expect(viaRegistry.message).toContain(`Refused (${code})`)
      expect(viaUpload.message).toBe(viaRegistry.message)
      expect(existsSync(plugins())).toBe(false)
      expect(await rows()).toEqual([])
      expect(heard).toEqual([])
    },
  )

  it('takes a lone .tgz as unsigned, refused unless .allow-unsigned exists', async () => {
    const lone = { ...uploadOf(echo('1.0.0')), entryText: null }
    const refused = await failureOf(
      installFromUploadProgram(FIXTURE_ACTOR.id, lone, source),
    )
    expect(refused.message).toContain('Refused (unsigned)')
    expect(await rows()).toEqual([])

    mkdirSync(plugins(), { recursive: true })
    writeFileSync(path.join(plugins(), '.allow-unsigned'), '')
    const outcome = await run(
      installFromUploadProgram(FIXTURE_ACTOR.id, lone, source),
    )
    expect(outcome).toMatchObject({
      version: '1.0.0',
      warning: expect.stringContaining('unsigned'),
    })
  })

  it('refuses an entry that is not a registry entry, and a tarball it cannot name', async () => {
    const plugin = echo('1.0.0')
    const bad = await failureOf(
      installFromUploadProgram(
        FIXTURE_ACTOR.id,
        { ...uploadOf(plugin), entryText: '{"id":"echo"}' },
        source,
      ),
    )
    expect(bad.message).toContain('not the registry entry')
    const unnamed = await failureOf(
      installFromUploadProgram(
        FIXTURE_ACTOR.id,
        { tarballName: 'plugin.tgz', tarball: plugin.tarball, entryText: null },
        source,
      ),
    )
    expect(unnamed.message).toContain('<id>-<version>.tgz')
    expect(await rows()).toEqual([])
  })
})

describe('update', () => {
  it('shows the newer registry version, then moves to it keeping the old one back', async () => {
    serve(echo('1.0.0'))
    await run(installFromRegistryProgram(FIXTURE_ACTOR.id, 'echo', source))
    const integrationId = (await rows()).at(0)?.id ?? ''
    serve(echo('1.0.0'), echo('1.1.0'))
    expect((await run(integrationLedgerProgram(source))).at(0)?.update).toBe(
      '1.1.0',
    )

    const outcome = await run(upgradeFromRegistryProgram(integrationId, source))
    expect(outcome.version).toBe('1.1.0')
    const dir = path.join(plugins(), 'echo')
    expect(readlinkSync(path.join(dir, 'current'))).toBe('1.1.0')
    expect(existsSync(path.join(dir, '1.0.0', 'bundle.mjs'))).toBe(true)
    expect((await run(integrationLedgerProgram(source))).at(0)).toMatchObject({
      version: '1.1.0',
      update: null,
    })

    const again = await failureOf(
      upgradeFromRegistryProgram(integrationId, source),
    )
    expect(again.message).toBe('Echo 1.1.0 is the newest version')
  })
})

describe('uninstall', () => {
  it('keeps the row and the attribution: a record the plugin created reads "Echo, since removed"', async () => {
    serve(echo('1.0.0'))
    await run(installFromRegistryProgram(FIXTURE_ACTOR.id, 'echo', source))
    const row = (await rows()).at(0)
    if (!row) throw new Error('no row')
    // A company the plugin created, and a value it filled on it.
    const { entityId } = await resolveEntity({
      kind: 'company',
      name: 'Echoed Co',
      keys: { domain: 'echoed.example' },
      source: { class: 'integration', ref: row.id },
    })
    await setValues({
      entityId,
      patch: { founded_year: 2015 },
      actor: { type: 'integration', id: row.id },
      source: 'enrichment',
    })

    await run(uninstallIntegrationProgram(row.id, false, source))

    expect(existsSync(path.join(plugins(), 'echo'))).toBe(false)
    expect(await run(integrationLedgerProgram(source))).toEqual([])
    const [kept] = await rows()
    expect(kept).toMatchObject({ id: row.id, enabled: false })
    expect(kept.removedAt).toBeInstanceOf(Date)
    const [born] = await db
      .select({ sourceClass: entity.sourceClass, sourceRef: entity.sourceRef })
      .from(entity)
      .where(eq(entity.id, entityId))
    expect(born).toEqual({ sourceClass: 'integration', sourceRef: row.id })
    const timeline = await run(recordTimelineProgram(entityId))
    expect(timeline.find((i) => i.type === 'attrs')).toMatchObject({
      actorType: 'integration',
      integrationName: 'Echo, since removed',
    })

    // Back in the registry pane; installing it again reuses the row.
    expect(
      (await run(availableProgram(source))).available.map((a) => a.pluginId),
    ).toEqual(['echo'])
    await run(installFromRegistryProgram(FIXTURE_ACTOR.id, 'echo', source))
    expect((await rows()).map((r) => [r.id, r.removedAt])).toEqual([
      [row.id, null],
    ])
    const timelineAfter = await run(recordTimelineProgram(entityId))
    expect(timelineAfter.find((i) => i.type === 'attrs')).toMatchObject({
      integrationName: 'Echo',
    })
  })
})

describe('the handlers', () => {
  it('refuse anyone but an admin every write; any member reads the catalogue', async () => {
    serve(echo('1.0.0'))
    session.current = { id: FIXTURE_ACTOR.id, role: 'member' }
    const id = '00000000-0000-4000-8000-000000000001'
    await expect(listAvailableHandler()).resolves.toBeDefined()
    await expect(
      installIntegrationHandler({ pluginId: 'echo' }),
    ).rejects.toThrow('Admins only')
    const plugin = echo('1.0.0')
    await expect(
      uploadIntegrationHandler({
        tarball: new File([Uint8Array.from(plugin.tarball)], 'echo-1.0.0.tgz'),
        entry: null,
      }),
    ).rejects.toThrow('Admins only')
    await expect(upgradeIntegrationHandler({ id })).rejects.toThrow(
      'Admins only',
    )
    await expect(
      uninstallIntegrationHandler({ id, dropData: true }),
    ).rejects.toThrow('Admins only')
    expect(await rows()).toEqual([])
  })
})
