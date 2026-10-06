import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { fixtureSigner } from '@spaces/core/plugins/fixtures'
import { loadPluginTrust } from '@spaces/core/plugins/trust'
import type { PluginTrust } from '@spaces/core/plugins/verify'
import {
  installPlugin,
  uninstallPlugin,
  upgradePlugin,
} from '@spaces/core/writes/plugins/install'
import { packPlugin } from '@spaces/sdk/pack'
import { reconcilePlugins } from './loader'

/**
 * The installer's output, read by the loader it was written for: the
 * `versioned` fixture packed and signed at 0.1.0 and 0.2.0, installed and
 * upgraded by core's installer into a scratch data directory, then
 * reconciled as the worker does on `plugin_changed`. No hand-made `current/`.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const signer = fixtureSigner()
let trust: PluginTrust
let data: string

beforeAll(async () => {
  const keysDir = mkdtempSync(path.join(tmpdir(), 'spaces-install-live-keys-'))
  signer.trustIn(keysDir)
  trust = await Effect.runPromise(
    loadPluginTrust({
      keysDir,
      dataDir: mkdtempSync(path.join(tmpdir(), 'spaces-install-live-trust-')),
    }),
  )
})

beforeEach(async () => {
  await db.execute(sql`truncate integration cascade`)
  data = mkdtempSync(path.join(tmpdir(), 'spaces-install-live-'))
})

/** The fixture's build at `version`, packed and signed as a release would be. */
const packed = async (version: string) => {
  const out = path.join(data, '..', `out-${version}-${Date.now()}`)
  mkdirSync(out, { recursive: true })
  const r = await packPlugin({
    distDir: path.join(fixtures, 'versioned', 'dist', version),
    outDir: out,
    privateKey: signer.privateKey,
  })
  if (r.entry === null) throw new Error('packed unsigned')
  return { tarball: readFileSync(r.tarball), entry: r.entry, trust }
}

const reconcile = () =>
  Effect.runPromise(
    reconcilePlugins({ pluginsRoot: path.join(data, 'plugins') }),
  )

describe('installed by the installer, loaded by the loader', () => {
  it('enables a fresh install pinned by lock.json, reloads it upgraded, and forgets it uninstalled', async () => {
    const { integrationId } = await Effect.runPromise(
      installPlugin(
        { ...(await packed('0.1.0')), actorId: null },
        { dataDir: data },
      ),
    )
    const first = await reconcile()
    expect(first.verdicts).toEqual([
      expect.objectContaining({
        integrationId,
        id: 'versioned',
        status: 'enabled',
        pinned: true,
      }),
    ])
    expect(first.loaded.at(0)?.manifest.version).toBe('0.1.0')
    const [row] = await db
      .select()
      .from(integration)
      .where(eq(integration.id, integrationId))
    expect(row.status).toBe('enabled')

    await Effect.runPromise(
      upgradePlugin(await packed('0.2.0'), { dataDir: data }),
    )
    const second = await reconcile()
    expect(second.verdicts.at(0)).toMatchObject({
      status: 'enabled',
      pinned: true,
    })
    expect(second.loaded.at(0)?.manifest.version).toBe('0.2.0')
    expect(second.loaded.at(0)?.fingerprint).not.toBe(
      first.loaded.at(0)?.fingerprint,
    )
    expect(
      existsSync(
        path.join(data, 'plugins', 'versioned', '0.1.0', 'bundle.mjs'),
      ),
    ).toBe(true)

    await Effect.runPromise(
      uninstallPlugin(
        { pluginId: 'versioned', dropData: false },
        { dataDir: data },
      ),
    )
    expect(await reconcile()).toEqual({ verdicts: [], loaded: [] })
  })
})
