import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  accountConnection,
  credential,
  integration,
  mailbox,
  user,
  workspace,
} from '@spaces/db/schema'
import type { IntegrationManifest } from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  companyCountProgram,
  setupAudienceProgram,
  setupGateProgram,
  whatsSetUpProgram,
} from './setup-status'

/**
 * The first-run reads against a real database: What's set up reads
 * each of its seven items live from the vault, users, mailbox, connections
 * and integrations; Today's empty state turns on the company count.
 */

const run = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(effect)

const APOLLO: IntegrationManifest = {
  manifestVersion: 1,
  id: 'apollo',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'Apollo',
  description: 'Fills blank company fields.',
  roles: ['enrichment'],
  settings: {},
  jobs: { enrichCompany: { trigger: 'action', uses: ['Read'] } },
  actions: [
    {
      id: 'enrich-company',
      label: 'Enrich',
      on: 'company',
      job: 'enrichCompany',
    },
  ],
}

const secret = (provider: string, kind: 'llm' | 'mailbox') =>
  db
    .insert(credential)
    .values({
      scope: 'workspace',
      provider,
      kind,
      secretEnc: Buffer.from('x'),
      createdBy: FIXTURE_ACTOR.id,
    })
    .returning({ id: credential.id })
    .then((rows) => rows.at(0)?.id ?? '')

const install = (capabilityId: string, manifest: IntegrationManifest | null) =>
  db
    .insert(integration)
    .values({
      capabilityId,
      version: '0.1.0',
      enabled: true,
      status: 'enabled',
      manifest,
    })
    .returning({ id: integration.id })
    .then((rows) => rows.at(0)?.id ?? '')

describe("What's set up", () => {
  it('reads all seven as not set in a fresh workspace', async () => {
    expect(await run(whatsSetUpProgram())).toEqual({
      model: false,
      team: false,
      enrichment: false,
      forwarding: false,
      google: false,
      granola: false,
      exa: false,
    })
  })

  it('reads each from where it lives', async () => {
    await secret('anthropic', 'llm')
    await db.insert(user).values({
      id: 'partner-1',
      name: 'Priya',
      email: 'priya@fund.example',
      emailVerified: true,
    })
    const channel = await install('core.mailbox', null)
    await db.insert(mailbox).values({
      integrationId: channel,
      address: 'deals@fund.example',
      host: 'imap.fund.example',
      credentialId: await secret('imap', 'mailbox'),
    })
    await db.insert(accountConnection).values({
      userId: FIXTURE_ACTOR.id,
      provider: 'google',
      product: 'calendar',
      externalEmail: 'fixture@fund.example',
      tokensEnc: Buffer.from('x'),
    })
    await install('apollo', APOLLO)
    await install('granola', null)
    await install('exa', null)

    expect(await run(whatsSetUpProgram())).toEqual({
      model: true,
      team: true,
      enrichment: true,
      forwarding: true,
      google: true,
      granola: true,
      exa: true,
    })
  })
})

describe('the first-run reads', () => {
  it('counts companies, so Today leaves its empty state once one exists', async () => {
    expect(await run(companyCountProgram())).toBe(0)
    await resolveEntity({
      kind: 'company',
      name: 'Orbital',
      keys: { domain: 'orbital.example' },
      source: { class: 'manual' },
      createdBy: FIXTURE_ACTOR.id,
    })
    expect(await run(companyCountProgram())).toBe(1)
  })

  it('names the admins a member asks', async () => {
    await db.insert(user).values({
      id: 'admin-2',
      name: 'Anish',
      email: 'anish@fund.example',
      emailVerified: true,
      role: 'admin',
    })
    expect(await run(setupAudienceProgram('member'))).toEqual({
      isAdmin: false,
      admins: ['Anish'],
    })
    expect((await run(setupAudienceProgram('admin'))).isAdmin).toBe(true)
  })
})

describe('the setup gate', () => {
  it('is closed once a user exists, and names the workspace when it has one', async () => {
    expect(await run(setupGateProgram())).toEqual({
      needsSetup: false,
      workspaceName: null,
    })
    await db.insert(workspace).values({ id: 1, name: 'Meridian Ventures' })
    expect(await run(setupGateProgram())).toEqual({
      needsSetup: false,
      workspaceName: 'Meridian Ventures',
    })
  })
})
