import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Effect } from 'effect'
import { isNotNull } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { canonicalFileUrl, storageSourceIntegrationFor } from './sources'

/**
 * The storage-source lookup reads each enabled row's manifest from the
 * plugins directory, so a row whose bundle says something else, or whose
 * row is off, is never the answer.
 */

let root: string

const writeManifest = (id: string, manifest: object) => {
  const dir = path.join(root, id, 'current')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
}

const drive = {
  id: 'drive-like',
  provides: 'storage-source',
  requires: { connection: { provider: 'google', scopes: ['drive.file'] } },
}

const insert = async (
  capabilityId: string,
  over: Partial<typeof integration.$inferInsert> = {},
) => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true, ...over })
      .returning({ id: integration.id })
  ).at(0)
  if (row === undefined) throw new Error('no row')
  return row.id
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'spaces-sources-'))
  // Each case sees only its own rows: the per-file truncate runs once.
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

const lookup = (provider: string) =>
  Effect.runPromise(
    storageSourceIntegrationFor(provider, { pluginsRoot: root }),
  )

describe('storageSourceIntegrationFor', () => {
  it('answers the enabled row whose manifest provides a storage source for the provider', async () => {
    writeManifest('drive-like', drive)
    writeManifest('mailer', {
      id: 'mailer',
      requires: { connection: { provider: 'google', scopes: [] } },
    })
    await insert('mailer')
    const id = await insert('drive-like')
    expect(await lookup('google')).toEqual({
      integrationId: id,
      pluginId: 'drive-like',
    })
    expect(await lookup('box')).toBeNull()
  })

  it('never answers a row that is off, removed or tripped, or has no bundle', async () => {
    writeManifest('drive-like', drive)
    await insert('drive-like', { enabled: false })
    await insert('drive-like', { removedAt: new Date() })
    await insert('drive-like', { status: 'disabled' })
    await insert('not-on-disk')
    expect(await lookup('google')).toBeNull()
  })
})

describe('canonicalFileUrl', () => {
  it('builds Drive’s file page and knows no other provider', () => {
    expect(canonicalFileUrl('google', 'abc-1')).toBe(
      'https://drive.google.com/file/d/abc-1/view',
    )
    expect(canonicalFileUrl('box', 'abc-1')).toBeNull()
  })
})
