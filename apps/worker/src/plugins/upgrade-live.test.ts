import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Effect, Fiber, Layer } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { fixtureSigner } from '@spaces/core/plugins/fixtures'
import { loadPluginTrust } from '@spaces/core/plugins/trust'
import type { PluginTrust } from '@spaces/core/plugins/verify'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  installPlugin,
  upgradePlugin,
} from '@spaces/core/writes/plugins/install'
import { packPlugin } from '@spaces/sdk/pack'
import type { RegistryEntry } from '@spaces/sdk/pack'
import {
  AUTOUPDATE_ENV,
  autoupdateModeOf,
  autoupdatePlugins,
} from './autoupdate'
import { makePluginHost } from './host'
import { listenPluginChanged } from './listen'
import { reconcilePlugins } from './loader'
import { makePluginReloader } from './reload'

/**
 * Plugin upgrade end to end on the `versioned` fixture, packed and signed:
 * the installer moves the bytes, the real loader migrates and loads them,
 * and the row's upgrade record answers rollback. Migrations are added to a
 * copy of the built version, so one fixture serves every case.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const signer = fixtureSigner()
let keysDir: string
let trust: PluginTrust
let data: string
const root = () => path.join(data, 'plugins')

beforeAll(async () => {
  keysDir = mkdtempSync(path.join(tmpdir(), 'spaces-upgrade-keys-'))
  signer.trustIn(keysDir)
  trust = await Effect.runPromise(
    loadPluginTrust({
      keysDir,
      dataDir: mkdtempSync(path.join(tmpdir(), 'spaces-upgrade-trust-')),
    }),
  )
})

beforeEach(async () => {
  await db.execute(sql`truncate integration cascade`)
  await db.execute(sql`drop schema if exists plugin_versioned cascade`)
  await db.execute(sql`drop table if exists public.versioned_leak`)
  data = mkdtempSync(path.join(tmpdir(), 'spaces-upgrade-'))
})

/** The fixture at `version` with these migrations, packed and signed; its entry names it by `file:` URL. */
const packed = async (
  version: string,
  migrations: { readonly [name: string]: string } = {},
) => {
  const scratch = mkdtempSync(path.join(tmpdir(), `spaces-upgrade-${version}-`))
  const dist = path.join(scratch, 'dist')
  cpSync(path.join(fixtures, 'versioned', 'dist', version), dist, {
    recursive: true,
  })
  for (const [name, text] of Object.entries(migrations)) {
    mkdirSync(path.join(dist, 'migrations'), { recursive: true })
    writeFileSync(path.join(dist, 'migrations', name), text)
  }
  const r = await packPlugin({
    distDir: dist,
    outDir: path.join(scratch, 'out'),
    privateKey: signer.privateKey,
  })
  if (r.entry === null) throw new Error('packed unsigned')
  const entry: RegistryEntry = {
    ...r.entry,
    tarball: pathToFileURL(r.tarball).href,
  }
  return { tarball: readFileSync(r.tarball), entry, trust }
}

const install = async (version: string) =>
  Effect.runPromise(
    installPlugin(
      { ...(await packed(version)), actorId: null },
      { dataDir: data },
    ),
  )

const reconcile = () =>
  Effect.runPromise(reconcilePlugins({ pluginsRoot: root() }))

const theRow = async () => {
  const row = (
    await db
      .select()
      .from(integration)
      .where(eq(integration.capabilityId, 'versioned'))
  ).at(0)
  if (!row) throw new Error('no versioned row')
  return row
}

/** lock.json's entry for the fixture, read back from disk. */
const locked = () => {
  const lock: unknown = JSON.parse(
    readFileSync(path.join(root(), 'lock.json'), 'utf8'),
  )
  return lock
}

const current = () => readlinkSync(path.join(root(), 'versioned', 'current'))

const tableExists = async (schema: string, table: string) =>
  (
    await db.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_schema = ${schema} and table_name = ${table}`,
    )
  ).rows.at(0)?.n === 1

describe('an upgrade migrates its own schema on reload, and the row answers rollback', () => {
  it('a migration that ran: unsafe, and the version line names it', async () => {
    await install('0.1.0')
    await reconcile()
    expect((await theRow()).upgradedFrom).toBeNull()

    await Effect.runPromise(
      upgradePlugin(
        await packed('0.2.0', {
          '0001_stamps.sql': 'create table stamps (id int primary key);',
        }),
        { dataDir: data },
      ),
    )
    expect(await theRow()).toMatchObject({
      version: '0.2.0',
      upgradedFrom: '0.1.0',
      upgradeMigrated: null,
    })

    const { verdicts } = await reconcile()
    expect(verdicts.at(0)?.line).toBe(
      '[plugins] versioned 0.2.0: enabled; migrated 0001_stamps.sql',
    )
    expect(await theRow()).toMatchObject({
      status: 'enabled',
      upgradeMigrated: true,
    })
    expect(await tableExists('plugin_versioned', 'stamps')).toBe(true)
    expect(locked()).toMatchObject({
      plugins: { versioned: { version: '0.2.0' } },
    })
    expect(current()).toBe('0.2.0')

    // A later load that applies nothing never turns the answer back.
    await reconcile()
    expect((await theRow()).upgradeMigrated).toBe(true)
  })

  it('no new migration: available, and the previous directory is kept to swap back', async () => {
    const v1 = await packed('0.1.0', {
      '0001_stamps.sql': 'create table stamps (id int);',
    })
    await Effect.runPromise(
      installPlugin({ ...v1, actorId: null }, { dataDir: data }),
    )
    await reconcile()
    expect(await tableExists('plugin_versioned', 'stamps')).toBe(true)

    await Effect.runPromise(
      upgradePlugin(
        await packed('0.2.0', {
          '0001_stamps.sql': 'create table stamps (id int);',
        }),
        { dataDir: data },
      ),
    )
    await reconcile()
    expect(await theRow()).toMatchObject({
      status: 'enabled',
      upgradedFrom: '0.1.0',
      upgradeMigrated: false,
    })
    expect(
      existsSync(path.join(root(), 'versioned', '0.1.0', 'bundle.mjs')),
    ).toBe(true)
  })

  it('a failing migration: degraded with the statement, the previous directory intact, public untouched', async () => {
    await install('0.1.0')
    await reconcile()

    await Effect.runPromise(
      upgradePlugin(
        await packed('0.2.0', {
          '0001_stamps.sql': [
            'create table stamps (id int);',
            'create table public.versioned_leak (id int);',
          ].join('\n'),
        }),
        { dataDir: data },
      ),
    )
    const { verdicts } = await reconcile()
    expect(verdicts.at(0)?.status).toBe('degraded')
    const row = await theRow()
    expect(row.status).toBe('degraded')
    expect(row.lastError).toContain(
      'migration 0001_stamps.sql failed at `create table public.versioned_leak (id int)',
    )
    // The run rolled back whole: nothing ran, so the old version still fits.
    expect(row.upgradeMigrated).toBe(false)
    expect(await tableExists('public', 'versioned_leak')).toBe(false)
    expect(await tableExists('plugin_versioned', 'stamps')).toBe(false)
    expect(
      existsSync(path.join(root(), 'versioned', '0.1.0', 'bundle.mjs')),
    ).toBe(true)
    // lock.json pins what `current` and the row name: the degraded version.
    expect(current()).toBe('0.2.0')
    expect(row.version).toBe('0.2.0')
    expect(locked()).toMatchObject({
      plugins: { versioned: { version: '0.2.0' } },
    })
  })
})

describe('one click: the installer, then the worker reloads over NOTIFY with no restart', () => {
  const stop: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const s of stop.splice(0)) await s()
  })

  it('the next stamp runs the new bundle', { timeout: 20_000 }, async () => {
    const { entityId } = await resolveEntity({
      kind: 'company',
      name: 'Upgraded Co',
      keys: { domain: 'upgraded.example' },
      source: { class: 'manual' },
    })
    const lines: Array<string> = []
    const logged: Array<string> = []
    const host = makePluginHost({
      enqueue: Layer.succeed(
        Enqueue,
        Enqueue.of({ enqueue: () => Effect.succeed(null) }),
      ),
      sink: (_level, line) => logged.push(line),
    })
    const reloader = makePluginReloader({
      host,
      pluginsRoot: root(),
      debounceMs: 20,
      log: (line) => lines.push(line),
    })
    const connectionString = process.env.DATABASE_URL
    if (connectionString === undefined) throw new Error('DATABASE_URL is unset')
    const listener = Effect.runFork(
      listenPluginChanged({
        connectionString,
        onChange: reloader.request,
        onListening: () => reloader.request(null),
        log: (line) => lines.push(line),
      }),
    )
    stop.push(async () => {
      await Effect.runPromise(Fiber.interrupt(listener))
      await Effect.runPromise(reloader.settled())
      await Effect.runPromise(host.releaseAll())
    })

    const { integrationId } = await install('0.1.0')
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++)
        await new Promise((r) => setTimeout(r, 25))
      await Effect.runPromise(reloader.settled())
    }
    await until(() => host.granted(integrationId, 'stamp') !== null)
    await Effect.runPromise(host.invoke(integrationId, 'stamp', { entityId }))

    lines.length = 0
    await Effect.runPromise(
      upgradePlugin(await packed('0.2.0'), { dataDir: data }),
    )
    await until(() =>
      lines.some((l) => l.startsWith('[plugins] versioned 0.2.0: enabled')),
    )
    await until(() => host.granted(integrationId, 'stamp') !== null)
    await Effect.runPromise(host.invoke(integrationId, 'stamp', { entityId }))

    expect(lines).toContain('[plugins] versioned: reloading')
    expect(logged.filter((l) => l.includes('stamp'))).toEqual([
      expect.stringContaining('"version":"0.1.0"'),
      expect.stringContaining('"version":"0.2.0"'),
    ])
    expect(await theRow()).toMatchObject({
      version: '0.2.0',
      status: 'enabled',
      upgradeMigrated: false,
    })
  })
})

describe('SPACES_PLUGINS_AUTOUPDATE', () => {
  /** A registry snapshot listing these entries. */
  const registry = (entries: ReadonlyArray<RegistryEntry>) => {
    const file = path.join(data, 'registry.json')
    writeFileSync(file, JSON.stringify(entries))
    return file
  }

  it('compatible takes the newest satisfying version, logs the take, and lock.json follows', async () => {
    const v1 = await packed('0.1.0')
    await Effect.runPromise(
      installPlugin({ ...v1, actorId: null }, { dataDir: data }),
    )
    const v2 = await packed('0.2.0')
    const registryFile = registry([
      v1.entry,
      v2.entry,
      { ...v2.entry, version: '0.3.0', sdk: '^2.0' },
    ])
    const lines: Array<string> = []

    const taken = await Effect.runPromise(
      autoupdatePlugins('compatible', {
        registryFile,
        keysDir,
        dataDir: data,
        log: (line) => lines.push(line),
      }),
    )

    expect(taken).toEqual([
      { pluginId: 'versioned', from: '0.1.0', to: '0.2.0' },
    ])
    expect(lines).toEqual([
      '[plugins] versioned: autoupdate took 0.2.0 over 0.1.0',
    ])
    expect(locked()).toMatchObject({
      plugins: { versioned: { version: '0.2.0' } },
    })
    expect(current()).toBe('0.2.0')
    expect(await theRow()).toMatchObject({
      version: '0.2.0',
      upgradedFrom: '0.1.0',
    })
    const { loaded } = await reconcile()
    expect(loaded.at(0)?.manifest.version).toBe('0.2.0')
  })

  it('a version that fails to verify is logged and the plugin keeps its own; lock.json unchanged', async () => {
    const v1 = await packed('0.1.0')
    await Effect.runPromise(
      installPlugin({ ...v1, actorId: null }, { dataDir: data }),
    )
    const v2 = await packed('0.2.0')
    const before = readFileSync(path.join(root(), 'lock.json'), 'utf8')
    const lines: Array<string> = []

    const taken = await Effect.runPromise(
      autoupdatePlugins('compatible', {
        registryFile: registry([{ ...v2.entry, sha256: '0'.repeat(64) }]),
        keysDir,
        dataDir: data,
        log: (line) => lines.push(line),
      }),
    )

    expect(taken).toEqual([])
    expect(lines).toEqual([
      expect.stringMatching(
        /^\[plugins\] versioned: autoupdate to 0\.2\.0 failed, keeping 0\.1\.0 — refused \(sha-mismatch\)/,
      ),
    ])
    expect(readFileSync(path.join(root(), 'lock.json'), 'utf8')).toBe(before)
    expect(current()).toBe('0.1.0')
  })

  const envs: Array<[string, { readonly [name: string]: string | undefined }]> =
    [
      [
        'unset, with only the required env',
        { DATABASE_URL: 'postgres://db', APP_URL: 'https://spaces.example' },
      ],
      ['any other value', { [AUTOUPDATE_ENV]: 'yes' }],
    ]
  it.each(envs)('%s takes nothing and says nothing', async (_, env) => {
    const v1 = await packed('0.1.0')
    await Effect.runPromise(
      installPlugin({ ...v1, actorId: null }, { dataDir: data }),
    )
    const v2 = await packed('0.2.0')
    const before = readFileSync(path.join(root(), 'lock.json'), 'utf8')
    const lines: Array<string> = []

    const taken = await Effect.runPromise(
      autoupdatePlugins(autoupdateModeOf(env[AUTOUPDATE_ENV]), {
        registryFile: registry([v1.entry, v2.entry]),
        keysDir,
        dataDir: data,
        log: (line) => lines.push(line),
      }),
    )

    expect(taken).toEqual([])
    expect(lines).toEqual([])
    expect(readFileSync(path.join(root(), 'lock.json'), 'utf8')).toBe(before)
    expect(current()).toBe('0.1.0')
    expect((await theRow()).version).toBe('0.1.0')
  })
})
