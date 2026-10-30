import { Effect } from 'effect'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  accountConnection,
  integration,
  user,
  workspace,
} from '@spaces/db/schema'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { storeCredential } from '@spaces/core/writes/vault'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  countIntegrationsHandler,
  listIntegrationsHandler,
} from '#/lib/integrations/admin'
import { uninstallIntegrationProgram } from '#/lib/integrations/install'
import {
  connectionsListHandler,
  providerPageHandler,
  setProviderChoiceHandler,
} from './providers'

/**
 * Settings → Connections against the test database: the provider rows, one
 * provider's page, the Set up answers in `workspace.settings`, and the
 * bundled plugins kept out of Plugins. Only the request is stubbed.
 */

const session: { current: { id: string; role: string } | null } = {
  current: null,
}

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('http://localhost/settings/connections'),
}))

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

const INES = { id: 'b3-ines', name: 'Ines', email: 'b3-ines@spaces.test' }

const asAdmin = () => {
  session.current = { id: FIXTURE_ACTOR.id, role: 'admin' }
}

beforeAll(async () => {
  await db.insert(user).values(INES).onConflictDoNothing()
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund One' })
    .onConflictDoNothing()
})

beforeEach(() => {
  session.current = { id: FIXTURE_ACTOR.id, role: 'member' }
})

const connect = (
  userId: string,
  product: string,
  externalEmail: string,
  over: { status?: 'active' | 'error'; errorReason?: string } = {},
) =>
  db.insert(accountConnection).values({
    userId,
    provider: 'google',
    product,
    externalEmail,
    tokensEnc: encryptBundle(
      { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer' },
      { userId, provider: 'google' },
    ),
    scopes: ['openid', 'email'],
    lastSyncAt: new Date(),
    ...over,
  })

describe('the bundled plugins and Plugins', () => {
  it('keeps them out of the ledger and its count, and refuses to uninstall one', async () => {
    const rows = await db
      .insert(integration)
      .values([
        { capabilityId: 'gmail', version: '0.1.0', enabled: true },
        { capabilityId: 'box', version: '0.1.0', enabled: true },
        { capabilityId: 'rss', version: '0.1.0', enabled: true },
      ])
      .returning({ id: integration.id, capabilityId: integration.capabilityId })

    expect((await listIntegrationsHandler()).map((r) => r.pluginId)).toEqual([
      'rss',
    ])
    expect(await countIntegrationsHandler()).toBe(1)

    const gmail = rows.find((r) => r.capabilityId === 'gmail')
    if (gmail === undefined) throw new Error('no gmail row')
    const refused = await Effect.runPromise(
      Effect.flip(uninstallIntegrationProgram(gmail.id, false)),
    )
    expect(refused.message).toContain('cannot be uninstalled')
    const still = await db
      .select({ removedAt: integration.removedAt })
      .from(integration)
      .where(eq(integration.id, gmail.id))
    expect(still).toEqual([{ removedAt: null }])
  })
})

describe('Settings → Connections', () => {
  it('lists each provider: set up or not, members connected of members, Testing, a refused client', async () => {
    const before = await connectionsListHandler()
    expect(before.map((r) => [r.provider, r.configured])).toEqual([
      ['google', false],
      ['box', false],
    ])

    await storeCredential({
      scope: 'workspace',
      provider: 'google',
      kind: 'oauth_client',
      secret: 'GOCSPX-secret',
      // The row setProviderApp writes: the secret's display beside the id.
      meta: {
        clientId: 'client.apps.googleusercontent.com',
        display: 'GOCS…cret',
      },
      createdBy: FIXTURE_ACTOR.id,
    })
    await connect(FIXTURE_ACTOR.id, 'gmail', 'anish@fund.example')
    await connect(INES.id, 'gmail', 'ines@gmail.com', {
      status: 'error',
      errorReason: 'invalid_client',
    })
    const google = (await connectionsListHandler()).find(
      (r) => r.provider === 'google',
    )
    expect(google).toMatchObject({
      configured: true,
      membersConnected: 2,
      testing: false,
      error: 'Google said: invalid_client',
    })
    expect(google?.members).toBeGreaterThanOrEqual(2)
  })

  it('reads one provider’s page: its uses with their switch and health, who is connected, the reader’s own account', async () => {
    // job_run is runJob's alone to write, so no run is seeded here: the
    // week's count is 0 and the failing member is named from the grant.
    const view = await providerPageHandler({ provider: 'google' })
    expect(
      view.uses.map((u) => [u.label, u.enabled, u.people, u.failed]),
    ).toEqual([
      ['Gmail', true, 2, 0],
      ['Google Calendar', false, 0, 0],
      ['Google Drive', false, 0, 0],
    ])
    expect(view.uses[0]?.failedWho).toBe('Ines')
    expect(view.uses[1]?.integrationId).toBeNull()
    expect(
      view.connected.map((c) => [c.name, c.email, c.uses, c.state]),
    ).toEqual([
      ['Test Fixture', 'anish@fund.example', 'Mail', 'ok'],
      ['Ines', 'ines@gmail.com', 'Mail', 'expired'],
    ])
    expect(view.mine).toBe('anish@fund.example')
    // A member reads the client with its secret redacted.
    expect(view.app.secretDisplay).toBe('set')
    expect(view.choices).toEqual({ audience: null, consent: null })
  })

  it('saves the Set up answers into workspace.settings.providers, admin only', async () => {
    await expect(
      setProviderChoiceHandler({ provider: 'google', audience: 'personal' }),
    ).rejects.toThrow('Admins only')

    asAdmin()
    expect(
      await setProviderChoiceHandler({
        provider: 'google',
        audience: 'personal',
        consent: 'external',
      }),
    ).toEqual({ audience: 'personal', consent: 'external' })
    expect(
      await setProviderChoiceHandler({
        provider: 'google',
        consent: 'internal',
      }),
    ).toEqual({ audience: 'personal', consent: 'internal' })
    const stored = await db
      .select({ settings: workspace.settings })
      .from(workspace)
      .where(eq(workspace.id, 1))
    expect(stored[0]?.settings.providers).toEqual({
      google: { audience: 'personal', consent: 'internal' },
    })
    // Personal Gmail is Testing on the list, before any grant says so.
    expect(
      (await connectionsListHandler()).find((r) => r.provider === 'google')
        ?.testing,
    ).toBe(true)
  })

  it('refuses a provider it does not know', async () => {
    await expect(
      providerPageHandler({ provider: 'microsoft' }),
    ).rejects.toThrow('Unknown provider')
  })
})
