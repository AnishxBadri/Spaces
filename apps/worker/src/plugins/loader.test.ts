import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Effect } from 'effect'
import { isNotNull, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as hostEffect from 'effect'
import * as hostSdk from '@spaces/sdk'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { readDegradedPlugins } from '@spaces/db/plugin-health'
import { bundleSha256 } from '@spaces/core/plugins/lock'
import { REASON_MAX, reconcilePlugins } from './loader'

/**
 * Boot reconciliation (sdk-11) against real bundles: the four fixtures under
 * plugins/_fixtures/ (echo, old-sdk, needs-key, tampered), built by turbo's
 * `^build` edge before this suite (they are this package's devDependencies),
 * copied into a data dir under the OS temp dir — outside every
 * `node_modules` the repo has, so a bundle's bare `effect` import resolves
 * only through the loader's hook.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-loader-')),
    'plugins',
  )
  mkdirSync(root, { recursive: true })
  return root
}

/** Copy a fixture's dist/ to `<root>/<id>/current/`, as the installer will. */
const install = (root: string, fixture: string, id = fixture) => {
  const dir = path.join(root, id, 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json']) {
    cpSync(path.join(fixtures, fixture, 'dist', file), path.join(dir, file))
  }
  return dir
}

const sha = (dir: string) =>
  bundleSha256(readFileSync(path.join(dir, 'bundle.mjs')))

const writeLock = (
  root: string,
  plugins: Record<string, { version: string; sha256: string }>,
) =>
  writeFileSync(
    path.join(root, 'lock.json'),
    JSON.stringify({ core: '0.1.0', plugins }),
  )

const row = async (
  capabilityId: string,
  extra: Partial<typeof integration.$inferInsert> = {},
) =>
  (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true, ...extra })
      .returning()
  ).at(0)

const rows = () =>
  db.select().from(integration).orderBy(integration.capabilityId)

/** Each row's xmin — it moves on any UPDATE, so equal xmins mean no write. */
const xmins = async () =>
  (
    await db.execute<{ capability_id: string; xmin: string }>(
      sql`select capability_id, xmin::text as xmin from integration order by capability_id`,
    )
  ).rows

const run = (pluginsRoot: string) =>
  Effect.runPromise(reconcilePlugins({ pluginsRoot }))

/** The four fixtures, a lock pinning the tampered one, then the tampering. */
const fourFixtures = async () => {
  const root = newPluginsRoot()
  install(root, 'echo')
  install(root, 'old-sdk')
  install(root, 'needs-key')
  const tampered = install(root, 'tampered')
  writeLock(root, { tampered: { version: '0.1.0', sha256: sha(tampered) } })
  appendFileSync(
    path.join(tampered, 'bundle.mjs'),
    '\n// edited after the lock was written\n',
  )
  for (const id of ['echo', 'old-sdk', 'needs-key', 'tampered']) await row(id)
  // The mailbox's row, exactly as `ensureIntegration` writes it.
  await row('core.mailbox', { version: '1', status: 'enabled' })
  return root
}

// Each test boots against the rows it seeds and nothing else: reconciliation
// reads every enabled row, so a row another test left would be reconciled
// (and written) against the wrong plugins root. The file's own table, not a
// cleanup list — the harness still truncates everything between files.
beforeEach(async () => {
  await db.delete(integration).where(isNotNull(integration.id))
})

describe('boot with the four fixtures', () => {
  it('enables echo and degrades the other three, each with its reason', async () => {
    const root = await fourFixtures()
    const { verdicts, loaded } = await run(root)

    expect(verdicts.map((v) => [v.id, v.status, v.reason])).toEqual([
      ['echo', 'enabled', null],
      ['needs-key', 'degraded', 'missing credential'],
      ['old-sdk', 'degraded', 'requires sdk ^2.0, host provides 1.0.0'],
      ['tampered', 'degraded', 'bundle sha does not match lock.json'],
    ])
    expect(loaded.map((p) => p.manifest.id)).toEqual(['echo'])
    expect(Object.keys(loaded.at(0)?.jobs ?? {}).sort()).toEqual([
      'echo',
      'enrich',
    ])

    const after = await rows()
    expect(after.map((r) => [r.capabilityId, r.status, r.lastError])).toEqual([
      ['core.mailbox', 'enabled', null],
      ['echo', 'enabled', null],
      ['needs-key', 'degraded', 'missing credential'],
      ['old-sdk', 'degraded', 'requires sdk ^2.0, host provides 1.0.0'],
      ['tampered', 'degraded', 'bundle sha does not match lock.json'],
    ])
  })

  it('writes each parsed manifest to its row — degraded ones too', async () => {
    const root = await fourFixtures()
    await run(root)
    const byId = new Map((await rows()).map((r) => [r.capabilityId, r]))
    for (const id of ['echo', 'old-sdk', 'needs-key', 'tampered']) {
      const stored = byId.get(id)?.manifest
      expect(stored?.id).toBe(id)
      expect(stored).toEqual(
        JSON.parse(
          readFileSync(path.join(root, id, 'current', 'manifest.json'), 'utf8'),
        ),
      )
    }
    // Web renders actions from the row, never from /data.
    expect(byId.get('echo')?.manifest?.actions).toHaveLength(2)
  })

  it('never touches a core.* row — no write, no verdict, no line', async () => {
    const root = await fourFixtures()
    const before = (await rows()).find((r) => r.capabilityId === 'core.mailbox')
    const xminBefore = (await xmins()).find(
      (r) => r.capability_id === 'core.mailbox',
    )
    const { verdicts } = await run(root)
    expect(
      (await rows()).find((r) => r.capabilityId === 'core.mailbox'),
    ).toEqual(before)
    expect(
      (await xmins()).find((r) => r.capability_id === 'core.mailbox'),
    ).toEqual(xminBefore)
    expect(verdicts.map((v) => v.line).join('\n')).not.toMatch(/mailbox|core\./)
  })

  it('lists the degraded ones for /api/health, and not the mailbox', async () => {
    await run(await fourFixtures())
    expect(await readDegradedPlugins()).toEqual([
      { id: 'needs-key', version: '0.1.0', reason: 'missing credential' },
      {
        id: 'old-sdk',
        version: '0.1.0',
        reason: 'requires sdk ^2.0, host provides 1.0.0',
      },
      {
        id: 'tampered',
        version: '0.1.0',
        reason: 'bundle sha does not match lock.json',
      },
    ])
  })

  it('is idempotent: a second boot writes nothing and agrees with the first', async () => {
    const root = await fourFixtures()
    const first = await run(root)
    const statuses = await rows()
    const written = await xmins()
    const second = await run(root)
    expect(second.verdicts).toEqual(first.verdicts)
    expect(await rows()).toEqual(statuses)
    expect(await xmins()).toEqual(written)
  })
})

describe('the bundle runs on the host', () => {
  it("resolves a bundle's effect, zod and @spaces/sdk to the worker's own copies", async () => {
    const root = newPluginsRoot()
    const dir = install(root, 'echo')
    await row('echo')
    const { verdicts } = await run(root)
    expect(verdicts.at(0)?.status).toBe('enabled')

    // A probe beside the bundle, importing exactly what a bundle imports.
    // The root is under the OS temp dir: without the hook none of these
    // three would resolve at all.
    writeFileSync(
      path.join(dir, 'probe.mjs'),
      [
        "export { Identity, Facts, definePlugin } from '@spaces/sdk'",
        "export { Effect, Context } from 'effect'",
        "export { z } from 'zod'",
      ].join('\n'),
    )
    const probe: unknown = await import(
      /* @vite-ignore */ pathToFileURL(path.join(dir, 'probe.mjs')).href
    )
    const seen = z
      .object({
        Identity: z.unknown(),
        Facts: z.unknown(),
        definePlugin: z.unknown(),
        Effect: z.unknown(),
        Context: z.unknown(),
        z: z.unknown(),
      })
      .parse(probe)
    expect(seen.Identity).toBe(hostSdk.Identity)
    expect(seen.Facts).toBe(hostSdk.Facts)
    expect(seen.definePlugin).toBe(hostSdk.definePlugin)
    expect(seen.Effect).toBe(hostEffect.Effect)
    expect(seen.Context).toBe(hostEffect.Context)
    expect(seen.z).toBe(z)
  })
})

describe('lock.json', () => {
  it('loads a plugin with no entry and records it unpinned', async () => {
    const root = newPluginsRoot()
    install(root, 'echo')
    await row('echo')
    const { verdicts } = await run(root)
    expect(verdicts.at(0)).toMatchObject({ status: 'enabled', pinned: false })
    expect(verdicts.at(0)?.line).toBe(
      '[plugins] echo 0.1.0: enabled (unpinned: no lock.json entry)',
    )
  })

  it('loads a plugin whose entry matches, pinned', async () => {
    const root = newPluginsRoot()
    const dir = install(root, 'echo')
    writeLock(root, { echo: { version: '0.1.0', sha256: sha(dir) } })
    await row('echo')
    const { verdicts } = await run(root)
    expect(verdicts.at(0)).toMatchObject({ status: 'enabled', pinned: true })
    expect(verdicts.at(0)?.line).toBe('[plugins] echo 0.1.0: enabled')
  })
})

describe('rows are the intent', () => {
  it('degrades a row whose files are missing, naming the expected path', async () => {
    const root = newPluginsRoot()
    await row('echo')
    const { verdicts } = await run(root)
    expect(verdicts.at(0)).toMatchObject({
      status: 'degraded',
      reason: `plugin file missing: ${path.join(root, 'echo', 'current', 'manifest.json')}`,
    })
  })

  it('ignores files with no row', async () => {
    const root = newPluginsRoot()
    install(root, 'echo')
    install(root, 'old-sdk')
    await row('echo')
    const { verdicts } = await run(root)
    expect(verdicts.map((v) => v.id)).toEqual(['echo'])
    expect((await rows()).map((r) => r.capabilityId)).toEqual(['echo'])
  })

  it('ignores a disabled row', async () => {
    const root = newPluginsRoot()
    await row('echo', { enabled: false })
    const { verdicts } = await run(root)
    expect(verdicts).toEqual([])
    expect((await rows()).at(0)?.status).toBe('installing')
  })
})

describe('a bundle whose top-level import throws', () => {
  it('degrades that plugin with the message truncated, and the others still load', async () => {
    const root = newPluginsRoot()
    install(root, 'echo')
    const dir = install(root, 'echo', 'boom')
    const manifest = z
      .record(z.string(), z.json())
      .parse(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')))
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...manifest, id: 'boom' }),
    )
    writeFileSync(
      path.join(dir, 'bundle.mjs'),
      `throw new Error('boom at import: ' + 'x'.repeat(2000))\n`,
    )
    await row('boom')
    await row('echo')
    const { verdicts } = await run(root)
    const boom = verdicts.find((v) => v.id === 'boom')
    expect(boom?.status).toBe('degraded')
    expect(boom?.reason).toMatch(
      /^bundle\.mjs failed to import: boom at import: x+…$/,
    )
    expect(boom?.reason?.length).toBe(REASON_MAX)
    expect(verdicts.find((v) => v.id === 'echo')?.status).toBe('enabled')
    const stored = (await rows()).find((r) => r.capabilityId === 'boom')
    expect(stored?.lastError).toBe(boom?.reason)
  })
})
