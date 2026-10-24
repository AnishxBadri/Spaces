import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Effect } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { CORE_VERSION } from '@spaces/core/plugins/core-version'
import { fixturePlugin, fixtureSigner } from '@spaces/core/plugins/fixtures'
import type { FixturePlugin } from '@spaces/core/plugins/fixtures'
import { SDK_VERSION } from '@spaces/sdk'
import type { RegistryEntry } from '@spaces/sdk/pack'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  installFromRegistryProgram,
  upgradeFromRegistryProgram,
} from './install'
import { integrationDetailProgram, integrationLedgerProgram } from './ledger'
import type { RegistrySource } from './registry'

/**
 * The update badge and the rollback answer, through the programs the
 * Integrations page calls: a registry.json and signed tarballs on disk, a
 * scratch data directory, the real database. The worker's half (migrations
 * on reload, the record it writes) is the worker's upgrade-live test.
 */

const signer = fixtureSigner()
let served: string
let source: RegistrySource & { registryFile: string; dataDir: string }

beforeEach(async () => {
  await db.execute(sql`truncate integration cascade`)
  served = mkdtempSync(path.join(tmpdir(), 'spaces-upgrade-registry-'))
  const keysDir = path.join(served, 'plugin-keys')
  mkdirSync(keysDir)
  signer.trustIn(keysDir)
  source = {
    registryFile: path.join(served, 'registry.json'),
    keysDir,
    dataDir: mkdtempSync(path.join(tmpdir(), 'spaces-upgrade-data-')),
  }
})

const echo = (version: string, manifest: { [key: string]: unknown } = {}) =>
  fixturePlugin({
    id: 'echo',
    version,
    signer,
    manifest: { name: 'Echo', ...manifest },
  })

/** Writes the tarballs beside a registry.json naming them by `file:` URL. */
const serve = (
  ...entries: Array<FixturePlugin & { extra?: Partial<RegistryEntry> }>
) => {
  const registry = entries.map(({ tarball, entry, extra }) => {
    const file = path.join(served, `${entry.id}-${entry.version}.tgz`)
    writeFileSync(file, tarball)
    return { ...entry, tarball: pathToFileURL(file).href, ...extra }
  })
  writeFileSync(source.registryFile, JSON.stringify(registry))
}

const run = <TValue, TError>(program: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(program)

const installed = async () => {
  serve(echo('1.0.0'))
  await run(installFromRegistryProgram(FIXTURE_ACTOR.id, 'echo', source))
  const id = (
    await db
      .select({ id: integration.id })
      .from(integration)
      .where(eq(integration.capabilityId, 'echo'))
  ).at(0)?.id
  if (id === undefined) throw new Error('no echo row')
  return id
}

const ledgerRow = async () =>
  (await run(integrationLedgerProgram(source))).at(0)

describe('the update badge', () => {
  it('names the newest satisfying version, and one click takes that one — not a newer one this host cannot run', async () => {
    const id = await installed()
    serve(echo('1.0.0'), echo('1.1.0'), echo('2.0.0', { sdk: '^2.0' }))
    expect(await ledgerRow()).toMatchObject({
      version: '1.0.0',
      update: '1.1.0',
      held: null,
      rollback: null,
    })

    const outcome = await run(upgradeFromRegistryProgram(id, source))
    expect(outcome.version).toBe('1.1.0')
    expect(await ledgerRow()).toMatchObject({
      version: '1.1.0',
      update: null,
      held: `2.0.0 needs sdk ^2.0; this host provides ${SDK_VERSION}`,
      rollback: { from: '1.0.0', answer: 'unknown' },
    })
  })

  it('shows no badge and says why when the newest version needs a newer core', async () => {
    await installed()
    serve(echo('1.0.0'), { ...echo('1.1.0'), extra: { minCore: '99.0.0' } })
    expect(await ledgerRow()).toMatchObject({
      update: null,
      held: `1.1.0 needs Spaces 99.0.0 or newer; this is ${CORE_VERSION}`,
    })
  })
})

describe('the rollback answer', () => {
  it.each([
    [true, 'unsafe'],
    [false, 'available'],
  ] as const)(
    'reads %s from the row as %s, on the ledger and the card',
    async (migrated, answer) => {
      const id = await installed()
      serve(echo('1.0.0'), echo('1.1.0'))
      await run(upgradeFromRegistryProgram(id, source))
      // What the worker's loader writes after step 5.
      await db
        .update(integration)
        .set({ upgradeMigrated: migrated })
        .where(eq(integration.id, id))

      expect((await ledgerRow())?.rollback).toEqual({ from: '1.0.0', answer })
      expect(
        (await run(integrationDetailProgram(id, source))).rollback,
      ).toEqual({ from: '1.0.0', answer })
    },
  )
})
