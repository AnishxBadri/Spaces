import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  entity,
  integration,
  signal,
} from '@spaces/db/schema'
import type { IntegrationManifest } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { integrationDetailProgram, integrationLedgerProgram } from './ledger'

/**
 * The plugin page's reads against a real database: what a plugin sends and
 * switches on, and the ledger's one number per job — signals a feed wrote,
 * people connected to the product a plugin reads. Rows are seeded the way
 * the loader leaves them; no plugin code runs.
 */

const manifest = (
  id: string,
  over: Partial<IntegrationManifest> = {},
): IntegrationManifest => ({
  manifestVersion: 1,
  id,
  version: '0.1.0',
  sdk: '^1.4',
  name: id.toUpperCase(),
  description: `The ${id} plugin.`,
  settings: {},
  jobs: { poll: { trigger: 'action', uses: ['Http', 'Content'] } },
  ...over,
})

const install = async (m: IntegrationManifest) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: String(m.id),
        version: String(m.version),
        enabled: true,
        status: 'enabled',
        manifest: m,
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row.id
}

beforeEach(async () => {
  await db.execute(sql`truncate integration, account_connection cascade`)
})

const run = <TValue, TError>(program: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(program)

describe('the page reads', () => {
  it('what a feed sends and switches on, and no runs before it ran', async () => {
    const rss = await install(manifest('rss', { roles: ['feeds'] }))
    const detail = await run(integrationDetailProgram(rss))
    expect(detail.sends).toEqual(['only the addresses its settings name'])
    expect(detail.capabilities).toEqual([
      { what: 'Adds feed items as signals', owner: 'watching' },
    ])
    // Runs are runJob's to write; the worker's plugin-page-runs test reads them.
    expect(detail.runs).toEqual([])
  })
})

describe('the one number', () => {
  it('counts the signals a feed wrote and the people connected to the product a plugin reads', async () => {
    const rss = await install(manifest('rss', { roles: ['feeds'] }))
    const drive = await install(
      manifest('google-drive', {
        roles: ['files'],
        requires: {
          connection: { provider: 'google', scopes: ['drive.file'] },
        },
      }),
    )
    const target = (
      await db
        .insert(entity)
        .values({ kind: 'company', canonicalName: 'Ohmium' })
        .returning({ id: entity.id })
    ).at(0)
    if (!target) throw new Error('no entity')
    await db.insert(signal).values(
      [1, 2].map((n) => ({
        entityId: target.id,
        source: 'rss',
        payload: { n },
        sourceClass: 'integration' as const,
        sourceRef: rss,
      })),
    )
    // One person with two Drive accounts, and a Gmail account Drive does not read.
    await db.insert(accountConnection).values(
      [
        ['drive', 'a@fund.example'],
        ['drive', 'b@fund.example'],
        ['gmail', 'a@fund.example'],
      ].map(([product, externalEmail]) => ({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product,
        externalEmail,
        tokensEnc: Buffer.from('x'),
      })),
    )

    const rows = await run(integrationLedgerProgram())
    expect(rows.map((r) => [r.pluginId, r.roles, r.figure])).toEqual([
      ['google-drive', ['files'], '1 person'],
      ['rss', ['feeds'], '2 signals'],
    ])
    expect(drive).toBe(rows.at(0)?.id)
  })
})
