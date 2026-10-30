import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Effect, Logger } from 'effect'
import { asc, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { credential, integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { fixturePlugin, fixtureSigner } from '@spaces/core/plugins/fixtures'
import type { FixturePlugin } from '@spaces/core/plugins/fixtures'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { redact, resolveSecret, storeCredential } from '../vault/index'
import {
  credentialSeeds,
  credentialVariable,
  firstBootPlugins,
  namedPlugins,
} from './first-boot'
import type { FirstBootEnv } from './first-boot'

/**
 * SPACES_PLUGINS and SPACES_CREDENTIAL_<ID> against a real database, a
 * scratch data directory and a registry of signed fixture tarballs served
 * by `file:` URL. The fetcher is counted, so "no re-download" is asserted
 * rather than inferred.
 */

const signer = fixtureSigner()

let served: string
let registryFile: string
let keysDir: string
let dataDir: string
let bundledDir: string
let fetched: Array<string>
let logs: Array<{ level: string; message: string }>

beforeEach(async () => {
  await db.execute(sql`truncate credential, integration cascade`)
  await db
    .update(user)
    .set({ role: 'member' })
    .where(eq(user.id, FIXTURE_ACTOR.id))
  served = mkdtempSync(path.join(tmpdir(), 'spaces-first-boot-registry-'))
  registryFile = path.join(served, 'registry.json')
  keysDir = path.join(served, 'plugin-keys')
  mkdirSync(keysDir)
  signer.trustIn(keysDir)
  dataDir = mkdtempSync(path.join(tmpdir(), 'spaces-first-boot-data-'))
  // Absent until a test ships something in it: the image's directory is not read.
  bundledDir = path.join(served, 'bundled-plugins')
  fetched = []
  logs = []
})

const serve = (...plugins: Array<FixturePlugin>) => {
  const registry = plugins.map(({ tarball, entry }) => {
    const file = path.join(served, `${entry.id}-${entry.version}.tgz`)
    writeFileSync(file, tarball)
    return { ...entry, tarball: pathToFileURL(file).href }
  })
  writeFileSync(registryFile, JSON.stringify(registry))
}

const capture = Logger.layer([
  Logger.make((o) => {
    const parts: ReadonlyArray<unknown> = Array.isArray(o.message)
      ? o.message
      : [o.message]
    logs.push({ level: o.logLevel, message: parts.map(String).join(' ') })
  }),
])

const boot = (env: FirstBootEnv) =>
  Effect.runPromise(
    firstBootPlugins({
      env,
      registryFile,
      keysDir,
      dataDir,
      bundledDir,
      fetchTarball: async (url) => {
        fetched.push(url)
        return readFile(fileURLToPath(url))
      },
    }).pipe(Effect.provide(capture)),
  )

const REQUIRED = {
  DATABASE_URL: 'postgresql://spaces:spaces@localhost:5432/spaces',
  APP_URL: 'http://localhost:3000',
}

const plugin = (
  id: string,
  version: string,
  extra: Partial<Parameters<typeof fixturePlugin>[0]> = {},
) => fixturePlugin({ id, version, signer, ...extra })

const lockFile = () => path.join(dataDir, 'plugins', 'lock.json')

/** Every row with `xmin`, which any UPDATE of the row changes. */
const rowsWithXmin = () =>
  db
    .select({
      id: integration.id,
      capabilityId: integration.capabilityId,
      version: integration.version,
      removedAt: integration.removedAt,
      credentialId: integration.credentialId,
      xmin: sql<string>`xmin::text`,
    })
    .from(integration)
    .orderBy(asc(integration.capabilityId))

const promoteFixtureAdmin = () =>
  db.update(user).set({ role: 'admin' }).where(eq(user.id, FIXTURE_ACTOR.id))

describe('the variables', () => {
  it('names the key variable by the plugin id, upper-cased, hyphens as underscores', () => {
    expect(credentialVariable('apollo')).toBe('SPACES_CREDENTIAL_APOLLO')
    expect(credentialVariable('rss-feeds')).toBe('SPACES_CREDENTIAL_RSS_FEEDS')
    expect(
      credentialSeeds({
        SPACES_CREDENTIAL_RSS_FEEDS: ' k-1 ',
        SPACES_CREDENTIAL_EMPTY: ' ',
        SPACES_PLUGINS: 'rss-feeds',
      }),
    ).toEqual([
      {
        variable: 'SPACES_CREDENTIAL_RSS_FEEDS',
        pluginId: 'rss-feeds',
        secret: 'k-1',
      },
    ])
  })

  it('reads SPACES_PLUGINS as a comma list of plugin ids', () => {
    expect(namedPlugins(' apollo, rss,,apollo , Bad_Id ')).toEqual({
      ids: ['apollo', 'rss'],
      invalid: ['Bad_Id'],
    })
    expect(namedPlugins(undefined)).toEqual({ ids: [], invalid: [] })
  })
})

describe('first boot with only the required env', () => {
  it('installs nothing and says nothing', async () => {
    serve(plugin('echo', '1.0.0'))
    expect(await boot(REQUIRED)).toEqual({
      bundled: [],
      installed: [],
      seeded: [],
    })
    expect(logs).toEqual([])
    expect(fetched).toEqual([])
    expect(existsSync(path.join(dataDir, 'plugins'))).toBe(false)
    expect(await rowsWithXmin()).toEqual([])
    expect(await db.select().from(credential)).toEqual([])
  })
})

describe('SPACES_PLUGINS', () => {
  it('installs the newest satisfying version of each named plugin; the second boot fetches and writes nothing', async () => {
    serve(
      plugin('echo', '1.0.0'),
      plugin('echo', '1.1.0'),
      // Newer, but for an SDK major this host does not have.
      plugin('echo', '2.0.0', { manifest: { sdk: '^2.0' } }),
      plugin('rss', '0.1.0'),
    )
    const env = { ...REQUIRED, SPACES_PLUGINS: 'echo,rss' }

    expect(await boot(env)).toEqual({
      bundled: [],
      installed: ['echo@1.1.0', 'rss@0.1.0'],
      seeded: [],
    })
    expect(fetched).toHaveLength(2)
    const first = await rowsWithXmin()
    expect(first.map((r) => [r.capabilityId, r.version, r.removedAt])).toEqual([
      ['echo', '1.1.0', null],
      ['rss', '0.1.0', null],
    ])
    const lockMtime = statSync(lockFile()).mtimeMs

    fetched = []
    logs = []
    expect(await boot(env)).toEqual({ bundled: [], installed: [], seeded: [] })
    expect(fetched).toEqual([])
    expect(logs).toEqual([])
    expect(statSync(lockFile()).mtimeMs).toBe(lockMtime)
    expect(await rowsWithXmin()).toEqual(first)
  })

  it('uninstalls nothing when the variable is unset again', async () => {
    serve(plugin('echo', '1.0.0'))
    await boot({ ...REQUIRED, SPACES_PLUGINS: 'echo' })
    const installed = await rowsWithXmin()
    const lockMtime = statSync(lockFile()).mtimeMs

    expect(await boot(REQUIRED)).toEqual({
      bundled: [],
      installed: [],
      seeded: [],
    })
    expect(await rowsWithXmin()).toEqual(installed)
    expect(statSync(lockFile()).mtimeMs).toBe(lockMtime)
    expect(
      existsSync(
        path.join(dataDir, 'plugins', 'echo', 'current', 'bundle.mjs'),
      ),
    ).toBe(true)
  })

  it('warns once for each plugin it cannot install, and installs the rest', async () => {
    const good = plugin('echo', '1.0.0')
    const tampered = Uint8Array.from(plugin('rss', '0.1.0').tarball)
    tampered[40] = (tampered.at(40) ?? 0) ^ 0xff
    serve(good, { ...plugin('rss', '0.1.0'), tarball: tampered })

    const result = await boot({
      ...REQUIRED,
      SPACES_PLUGINS: 'missing, rss, echo, Bad_Id',
    })
    expect(result.installed).toEqual(['echo@1.0.0'])
    const warnings = logs
      .filter((l) => l.level === 'Warn')
      .map((l) => l.message)
    expect(warnings).toHaveLength(3)
    expect(warnings.join('\n')).toContain("'Bad_Id' is not a plugin id")
    expect(warnings.join('\n')).toContain('no version of missing')
    expect(warnings.join('\n')).toContain(
      'rss not installed — refused (sha-mismatch)',
    )
    expect((await rowsWithXmin()).map((r) => r.capabilityId)).toEqual(['echo'])
  })
})

describe('SPACES_CREDENTIAL_<ID>', () => {
  const keyed = () =>
    plugin('echo-key', '1.0.0', {
      requires: { credential: { kind: 'enrichment', scope: 'workspace' } },
    })

  const workspaceKeys = () =>
    db
      .select({
        id: credential.id,
        provider: credential.provider,
        scope: credential.scope,
        kind: credential.kind,
        meta: credential.meta,
        createdBy: credential.createdBy,
      })
      .from(credential)

  it('seeds the workspace key, provider = <id>, in the shape the Integrations page writes', async () => {
    await promoteFixtureAdmin()
    serve(keyed())
    const result = await boot({
      ...REQUIRED,
      SPACES_PLUGINS: 'echo-key',
      SPACES_CREDENTIAL_ECHO_KEY: 'env-secret-1234',
    })
    expect(result).toEqual({
      bundled: [],
      installed: ['echo-key@1.0.0'],
      seeded: ['echo-key'],
    })
    const keys = await workspaceKeys()
    expect(keys).toEqual([
      {
        id: expect.any(String),
        provider: 'echo-key',
        scope: 'workspace',
        kind: 'enrichment',
        meta: { display: redact('env-secret-1234'), slot: 'credential' },
        createdBy: FIXTURE_ACTOR.id,
      },
    ])
    expect((await rowsWithXmin()).at(0)?.credentialId).toBe(keys.at(0)?.id)
    expect(await resolveSecret('echo-key', 'enrichment')).toBe(
      'env-secret-1234',
    )
  })

  it('keeps the key changed in the UI across a reboot with the variable still set', async () => {
    await promoteFixtureAdmin()
    serve(keyed())
    const env = {
      ...REQUIRED,
      SPACES_PLUGINS: 'echo-key',
      SPACES_CREDENTIAL_ECHO_KEY: 'env-secret-1234',
    }
    await boot(env)
    // What saveIntegrationSecretProgram writes: the same row, a new secret.
    await storeCredential({
      scope: 'workspace',
      provider: 'echo-key',
      kind: 'enrichment',
      secret: 'ui-secret-5678',
      meta: { display: redact('ui-secret-5678'), slot: 'credential' },
      createdBy: FIXTURE_ACTOR.id,
    })
    const before = await rowsWithXmin()

    expect(await boot(env)).toEqual({ bundled: [], installed: [], seeded: [] })
    expect(await resolveSecret('echo-key', 'enrichment')).toBe('ui-secret-5678')
    expect(await workspaceKeys()).toHaveLength(1)
    expect(await rowsWithXmin()).toEqual(before)
  })

  it('waits for the first admin, and seeds on the first boot after setup', async () => {
    serve(keyed())
    const env = {
      ...REQUIRED,
      SPACES_PLUGINS: 'echo-key',
      SPACES_CREDENTIAL_ECHO_KEY: 'env-secret-1234',
    }
    expect((await boot(env)).seeded).toEqual([])
    expect(logs.map((l) => l.message).join('\n')).toContain(
      'SPACES_CREDENTIAL_ECHO_KEY: no admin exists yet',
    )
    expect(await workspaceKeys()).toEqual([])

    await promoteFixtureAdmin()
    expect((await boot(env)).seeded).toEqual(['echo-key'])
  })

  it('seeds nothing for a plugin that is not installed or takes no key', async () => {
    await promoteFixtureAdmin()
    serve(plugin('echo', '1.0.0'))
    const result = await boot({
      ...REQUIRED,
      SPACES_PLUGINS: 'echo',
      SPACES_CREDENTIAL_ECHO: 'k-1',
      SPACES_CREDENTIAL_APOLLO: 'k-2',
    })
    expect(result.seeded).toEqual([])
    const said = logs.map((l) => l.message).join('\n')
    expect(said).toContain('SPACES_CREDENTIAL_ECHO: echo takes no key')
    expect(said).toContain('SPACES_CREDENTIAL_APOLLO: apollo is not installed')
    expect(await workspaceKeys()).toEqual([])
  })
})

describe('bundled plugins', () => {
  /** Ships a tarball in the image's directory; signed ships its entry beside it. */
  const ship = (bundle: FixturePlugin, signed: boolean) => {
    mkdirSync(bundledDir, { recursive: true })
    const base = `${bundle.entry.id}-${bundle.entry.version}`
    writeFileSync(path.join(bundledDir, `${base}.tgz`), bundle.tarball)
    if (signed)
      writeFileSync(
        path.join(bundledDir, `${base}.json`),
        JSON.stringify(bundle.entry),
      )
  }

  it('installs each one with no SPACES_PLUGINS, unsigned or signed; the second boot writes nothing', async () => {
    ship(plugin('gmail', '0.1.0'), false)
    ship(plugin('box', '0.2.0'), true)

    expect(await boot(REQUIRED)).toEqual({
      bundled: ['box@0.2.0', 'gmail@0.1.0'],
      installed: [],
      seeded: [],
    })
    // Nothing came from the registry, and the unsigned one needed no marker.
    expect(fetched).toEqual([])
    const first = await rowsWithXmin()
    expect(first.map((r) => [r.capabilityId, r.version, r.removedAt])).toEqual([
      ['box', '0.2.0', null],
      ['gmail', '0.1.0', null],
    ])
    expect(
      existsSync(
        path.join(dataDir, 'plugins', 'gmail', 'current', 'bundle.mjs'),
      ),
    ).toBe(true)

    logs = []
    expect(await boot(REQUIRED)).toEqual({
      bundled: [],
      installed: [],
      seeded: [],
    })
    expect(logs).toEqual([])
    expect(await rowsWithXmin()).toEqual(first)
  })

  it('upgrades a row to the image’s newer version, and leaves a newer row alone', async () => {
    ship(plugin('gmail', '0.1.0'), false)
    await boot(REQUIRED)
    rmSync(bundledDir, { recursive: true })

    ship(plugin('gmail', '0.2.0'), false)
    expect((await boot(REQUIRED)).bundled).toEqual(['gmail@0.2.0'])
    expect((await rowsWithXmin()).map((r) => r.version)).toEqual(['0.2.0'])
    rmSync(bundledDir, { recursive: true })

    ship(plugin('gmail', '0.1.0'), false)
    expect((await boot(REQUIRED)).bundled).toEqual([])
    expect((await rowsWithXmin()).map((r) => r.version)).toEqual(['0.2.0'])
  })

  it('reinstalls an uninstalled one on its old row', async () => {
    ship(plugin('gmail', '0.1.0'), false)
    await boot(REQUIRED)
    const row = (await rowsWithXmin()).at(0)
    await db
      .update(integration)
      .set({ removedAt: new Date() })
      .where(eq(integration.capabilityId, 'gmail'))

    expect((await boot(REQUIRED)).bundled).toEqual(['gmail@0.1.0'])
    const after = await rowsWithXmin()
    expect(after.map((r) => [r.id, r.removedAt])).toEqual([[row?.id, null]])
  })

  it('refuses a signed one whose signature is not the image’s, and boots on', async () => {
    const stranger = fixturePlugin({
      id: 'gmail',
      version: '0.1.0',
      signer: fixtureSigner(),
    })
    ship(stranger, true)
    ship(plugin('box', '0.1.0'), false)

    expect((await boot(REQUIRED)).bundled).toEqual(['box@0.1.0'])
    expect(
      logs
        .filter((l) => l.level === 'Warn')
        .map((l) => l.message)
        .join('\n'),
    ).toContain('gmail 0.1.0 not installed — refused (unknown-key)')
    expect((await rowsWithXmin()).map((r) => r.capabilityId)).toEqual(['box'])
  })
})
