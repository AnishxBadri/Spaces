import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createHash, sign } from 'node:crypto'
import { Effect, Exit } from 'effect'
import { eq, sql } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { credential, entity, integration } from '@spaces/db/schema'
import { readTar, writeTar } from '@spaces/sdk/pack'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { fixturePlugin, fixtureSigner } from '@spaces/core/plugins/fixtures'
import type { FixturePlugin } from '@spaces/core/plugins/fixtures'
import { CORE_VERSION } from '@spaces/core/plugins/core-version'
import { loadPluginTrust } from '@spaces/core/plugins/trust'
import type { EntryToVerify, PluginTrust } from '@spaces/core/plugins/verify'
import { resolveEntity } from '../entities/resolve'
import { storeCredential } from '../vault/index'
import {
  PLUGIN_CHANGED,
  installPlugin,
  uninstallPlugin,
  upgradePlugin,
} from './install'
import { pluginSchemaName } from './schema'

/**
 * The installer against a real database and a scratch data directory:
 * install, the eight refusals writing nothing, upgrade keeping one version
 * back, and uninstall keeping the row for provenance.
 */

const signer = fixtureSigner()
let trust: PluginTrust
let notified: Array<string>
let listener: PoolClient

beforeAll(async () => {
  const keysDir = mkdtempSync(path.join(tmpdir(), 'spaces-install-keys-'))
  signer.trustIn(keysDir)
  trust = await Effect.runPromise(
    loadPluginTrust({
      keysDir,
      dataDir: mkdtempSync(path.join(tmpdir(), 'spaces-install-trust-')),
    }),
  )
  // A pooled connection held for the file: what the worker's LISTEN hears.
  listener = await db.$client.connect()
  await listener.query(`listen ${PLUGIN_CHANGED}`)
  listener.on('notification', (n) => notified.push(n.payload ?? ''))
})

afterAll(async () => {
  listener.release()
})

let data: string
const plugins = () => path.join(data, 'plugins')

// Isolation is per file; each test here starts with no integration rows.
beforeEach(async () => {
  await db.execute(sql`truncate integration cascade`)
  data = mkdtempSync(path.join(tmpdir(), 'spaces-install-'))
  notified = []
})

const echo = (
  version: string,
  extra: Partial<Parameters<typeof fixturePlugin>[0]> = {},
) => fixturePlugin({ id: 'echo', version, signer, ...extra })

const install = (p: { tarball: Uint8Array; entry: EntryToVerify }) =>
  Effect.runPromise(
    installPlugin(
      { tarball: p.tarball, entry: p.entry, trust, actorId: FIXTURE_ACTOR.id },
      { dataDir: data },
    ),
  )

const upgrade = (p: FixturePlugin) =>
  Effect.runPromise(
    upgradePlugin(
      { tarball: p.tarball, entry: p.entry, trust },
      { dataDir: data },
    ),
  )

const uninstall = (pluginId: string, dropData = false) =>
  Effect.runPromise(uninstallPlugin({ pluginId, dropData }, { dataDir: data }))

const lockJson = (): unknown =>
  JSON.parse(readFileSync(path.join(plugins(), 'lock.json'), 'utf8'))

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

const bundleOf = (p: FixturePlugin) =>
  readTar(gunzipSync(p.tarball)).find((e) => e.path === 'bundle.mjs')?.data ??
  new Uint8Array()

/** Until the NOTIFY sent after commit reaches the listener. */
const heard = async (pluginId: string) => {
  for (let i = 0; i < 50 && !notified.includes(pluginId); i++)
    await new Promise((r) => setTimeout(r, 20))
  return notified.includes(pluginId)
}

const failureOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>): TError => {
  if (Exit.isSuccess(exit)) throw new Error('expected a failure')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

const rowsOf = (pluginId: string) =>
  db.select().from(integration).where(eq(integration.capabilityId, pluginId))

describe('install', () => {
  it('lands the files, pins lock.json, writes the row and notifies', async () => {
    const v1 = echo('1.0.0', {
      files: { 'migrations/0001_init.sql': 'select 1;' },
    })
    const result = await install(v1)

    const dir = path.join(plugins(), 'echo')
    expect(readdirSync(path.join(dir, '1.0.0')).sort()).toEqual([
      'bundle.mjs',
      'manifest.json',
      'migrations',
    ])
    expect(readlinkSync(path.join(dir, 'current'))).toBe('1.0.0')
    expect(lockJson()).toEqual({
      core: CORE_VERSION,
      plugins: { echo: { version: '1.0.0', sha256: sha(bundleOf(v1)) } },
    })
    const [row] = await rowsOf('echo')
    expect(row).toMatchObject({
      id: result.integrationId,
      version: '1.0.0',
      enabled: true,
      status: 'installing',
      removedAt: null,
      createdBy: FIXTURE_ACTOR.id,
    })
    expect(row.manifest).toMatchObject({ id: 'echo', name: 'Echo' })
    expect(await heard('echo')).toBe(true)
  })

  it('refuses a second install of an installed plugin', async () => {
    await install(echo('1.0.0'))
    const exit = await Effect.runPromiseExit(
      installPlugin(
        { ...echo('1.0.0'), trust, actorId: null },
        { dataDir: data },
      ),
    )
    expect(failureOf(exit)).toMatchObject({
      _tag: 'InstallRefused',
      message: expect.stringContaining('already installed'),
    })
    expect(await rowsOf('echo')).toHaveLength(1)
  })
})

describe('a refused tarball writes nothing', () => {
  const good = () => echo('1.0.0')
  const signed = (bytes: Uint8Array, base: FixturePlugin) => ({
    tarball: bytes,
    entry: {
      ...base.entry,
      sha256: sha(bytes),
      sig: sign(null, bytes, signer.privateKey).toString('base64'),
    },
  })
  const tgz = (files: Array<{ path: string; body: string }>) =>
    gzipSync(
      writeTar(
        files.map((f) => ({
          path: f.path,
          data: new TextEncoder().encode(f.body),
        })),
      ),
    )

  const cases: Array<
    [string, () => { tarball: Uint8Array; entry: EntryToVerify }]
  > = [
    [
      'sha-mismatch',
      () => ({ ...good(), entry: { ...good().entry, sha256: '0'.repeat(64) } }),
    ],
    [
      'unknown-key',
      () => ({
        ...good(),
        entry: { ...good().entry, keyId: 'ed25519-0000000000000000' },
      }),
    ],
    [
      'bad-signature',
      () => {
        const g = good()
        return {
          ...g,
          entry: {
            ...g.entry,
            sig: sign(null, new Uint8Array([1]), signer.privateKey).toString(
              'base64',
            ),
          },
        }
      },
    ],
    [
      'unsigned',
      () => ({ ...good(), entry: { ...good().entry, sig: null, keyId: null } }),
    ],
    [
      'unreadable',
      () => signed(new TextEncoder().encode('not a tarball'), good()),
    ],
    [
      'unsafe-entry',
      () =>
        signed(
          tgz([
            { path: 'manifest.json', body: '{}' },
            { path: '../evil.mjs', body: 'x' },
          ]),
          good(),
        ),
    ],
    [
      'manifest-missing',
      () => signed(tgz([{ path: 'bundle.mjs', body: 'x' }]), good()),
    ],
    [
      'manifest-mismatch',
      () => {
        const other = fixturePlugin({ id: 'echo', version: '9.9.9', signer })
        return signed(other.tarball, good())
      },
    ],
  ]

  it.each(cases)(
    '%s: no directory, no lock.json edit, no row',
    async (code, make) => {
      // An existing lock.json must come through byte for byte.
      mkdirSync(plugins(), { recursive: true })
      const lock = `${JSON.stringify({ plugins: {} })}\n`
      writeFileSync(path.join(plugins(), 'lock.json'), lock)

      const exit = await Effect.runPromiseExit(
        installPlugin({ ...make(), trust, actorId: null }, { dataDir: data }),
      )
      expect(failureOf(exit)).toMatchObject({ _tag: 'PluginRefused', code })
      expect(readdirSync(plugins())).toEqual(['lock.json'])
      expect(readFileSync(path.join(plugins(), 'lock.json'), 'utf8')).toBe(lock)
      expect(await rowsOf('echo')).toEqual([])
      expect(notified).toEqual([])
    },
  )
})

describe('upgrade', () => {
  it('adds a version directory, swaps current, keeps one back and prunes the rest', async () => {
    const { integrationId } = await install(echo('1.0.0'))
    const v2 = echo('1.1.0', { bundle: 'export default { two: true }\n' })
    const second = await upgrade(v2)
    const dir = path.join(plugins(), 'echo')

    expect(second).toMatchObject({
      integrationId,
      version: '1.1.0',
      previous: '1.0.0',
    })
    expect(readlinkSync(path.join(dir, 'current'))).toBe('1.1.0')
    expect(existsSync(path.join(dir, '1.0.0', 'bundle.mjs'))).toBe(true)
    expect(lockJson()).toMatchObject({
      plugins: { echo: { version: '1.1.0', sha256: sha(bundleOf(v2)) } },
    })
    const [row] = await rowsOf('echo')
    expect(row).toMatchObject({
      id: integrationId,
      version: '1.1.0',
      status: 'installing',
    })
    expect(await heard('echo')).toBe(true)

    await upgrade(echo('2.0.0'))
    expect(readdirSync(dir).sort()).toEqual(['1.1.0', '2.0.0', 'current'])
    expect(lstatSync(path.join(dir, 'current')).isSymbolicLink()).toBe(true)
  })

  it('refuses a plugin that is not installed', async () => {
    const exit = await Effect.runPromiseExit(
      upgradePlugin({ ...echo('1.0.0'), trust }, { dataDir: data }),
    )
    expect(failureOf(exit)).toMatchObject({
      _tag: 'InstallRefused',
      message: 'echo is not installed',
    })
    expect(existsSync(plugins())).toBe(false)
  })
})

describe('uninstall', () => {
  it('removes files and key, keeps the row and every source_ref, and a reinstall reuses the row', async () => {
    const { integrationId } = await install(echo('1.0.0'))
    const stored = await storeCredential({
      scope: 'workspace',
      provider: 'echo',
      kind: 'enrichment',
      secret: 'echo-key-000000000000',
      createdBy: FIXTURE_ACTOR.id,
    })
    const webhook = await storeCredential({
      scope: 'workspace',
      provider: 'echo:webhook',
      kind: 'webhook',
      secret: 'echo-webhook-secret-0000',
      createdBy: FIXTURE_ACTOR.id,
    })
    await db
      .update(integration)
      .set({ credentialId: stored.id, webhookCredentialId: webhook.id })
      .where(eq(integration.id, integrationId))
    // A record the plugin created.
    const { entityId } = await resolveEntity({
      kind: 'company',
      name: 'Echoed Co',
      keys: { domain: 'echoed.example' },
      source: { class: 'integration', ref: integrationId },
    })
    notified = []

    await uninstall('echo')

    expect(existsSync(path.join(plugins(), 'echo'))).toBe(false)
    expect(lockJson()).toEqual({ core: CORE_VERSION, plugins: {} })
    for (const held of [stored.id, webhook.id])
      expect(
        await db.select().from(credential).where(eq(credential.id, held)),
      ).toEqual([])
    const [row] = await rowsOf('echo')
    expect(row).toMatchObject({
      id: integrationId,
      enabled: false,
      credentialId: null,
      webhookCredentialId: null,
    })
    expect(row.removedAt).toBeInstanceOf(Date)
    const [born] = await db
      .select({ sourceClass: entity.sourceClass, sourceRef: entity.sourceRef })
      .from(entity)
      .where(eq(entity.id, entityId))
    expect(born).toEqual({
      sourceClass: 'integration',
      sourceRef: integrationId,
    })
    expect(await heard('echo')).toBe(true)

    const again = await install(echo('1.1.0'))
    expect(again.integrationId).toBe(integrationId)
    const rows = await rowsOf('echo')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      version: '1.1.0',
      enabled: true,
      removedAt: null,
      status: 'installing',
    })
  })

  it('drops plugin_<id> only when asked', async () => {
    const schema = pluginSchemaName('echo')
    const exists = async () =>
      (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from information_schema.schemata where schema_name = ${schema}`,
        )
      ).rows[0]?.n
    await db.execute(
      sql`drop schema if exists ${sql.identifier(schema)} cascade`,
    )
    await db.execute(sql`create schema ${sql.identifier(schema)}`)

    await install(echo('1.0.0'))
    await uninstall('echo')
    expect(await exists()).toBe(1)

    await install(echo('1.0.0'))
    await uninstall('echo', true)
    expect(await exists()).toBe(0)
  })

  it('refuses a plugin that is not installed', async () => {
    const exit = await Effect.runPromiseExit(
      uninstallPlugin({ pluginId: 'echo', dropData: false }, { dataDir: data }),
    )
    expect(failureOf(exit)).toMatchObject({
      _tag: 'InstallRefused',
      message: 'echo is not installed',
    })
  })
})
