import { Effect, Exit } from 'effect'
import { isNotNull } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { accountConnection, integration } from '@spaces/db/schema'
import { encryptBundle } from '@spaces/core/writes/connections/bundle'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  PickerScopeTooBroad,
  mintPickerTokenProgram,
  pickerReadinessProgram,
} from './picker'
import type { MintPickerOutcome, PickerOptions } from './picker'

/**
 * The picker's mint: Connect without a connection, a re-consent without
 * the picker scope, a refusal for a scope that does not read a picked file,
 * and otherwise a token for this one call with the row's key and app id.
 */

const TOKEN = 'ya29.picker-access-token'
const RETURN = '/companies/1'
const LIVE: PickerOptions = { returnTo: RETURN, fake: false }

const MANIFEST = {
  id: 'google-drive',
  provides: 'storage-source',
  requires: { connection: { provider: 'google', scopes: ['drive.file'] } },
}

beforeEach(async () => {
  await db.delete(accountConnection).where(isNotNull(accountConnection.id))
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
})

const aDriveRow = async (config: { [key: string]: string } = {}) => {
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'google-drive',
        version: '0.1.0',
        enabled: true,
        manifest: MANIFEST,
        config: { folderId: 'dataroom', ...config },
      })
      .returning({ id: integration.id })
  ).at(0)
  if (row === undefined) throw new Error('no integration')
  return row.id
}

const configured = () =>
  aDriveRow({ pickerApiKey: 'AIza-picker', pickerAppId: '123456789012' })

const aConnection = async (
  scopes: Array<string>,
  over: { status?: 'active' | 'error'; errorReason?: string } = {},
) => {
  const row = (
    await db
      .insert(accountConnection)
      .values({
        userId: FIXTURE_ACTOR.id,
        provider: 'google',
        product: 'drive',
        externalEmail: `${crypto.randomUUID()}@fund.example`,
        tokensEnc: encryptBundle(
          { accessToken: TOKEN, refreshToken: 'refresh', tokenType: 'Bearer' },
          { userId: FIXTURE_ACTOR.id, provider: 'google' },
        ),
        scopes,
        expiresAt: new Date(Date.now() + 3_600_000),
        status: over.status ?? 'active',
        errorReason: over.errorReason ?? null,
      })
      .returning({ id: accountConnection.id })
  ).at(0)
  if (row === undefined) throw new Error('no connection')
  return row.id
}

const mint = (options: PickerOptions = LIVE) =>
  Effect.runPromise(mintPickerTokenProgram(FIXTURE_ACTOR.id, 'google', options))

const readiness = (options: PickerOptions = LIVE) =>
  Effect.runPromise(pickerReadinessProgram(FIXTURE_ACTOR.id, 'google', options))

/** Every outcome but `ok`, and `ok` without its token, must not carry it. */
const leaks = (outcome: MintPickerOutcome) =>
  JSON.stringify(
    outcome._tag === 'ok' ? { ...outcome, token: null } : outcome,
  ).includes(TOKEN)

describe('mintPickerTokenProgram', () => {
  it('offers Connect, back to the record, when the user holds no Drive connection', async () => {
    await configured()
    const outcome = await mint()
    expect(outcome).toEqual({
      _tag: 'connect',
      href: `/api/connections/google/start?product=drive&return=${encodeURIComponent(RETURN)}`,
      label: 'Connect Drive',
    })
    expect(await readiness()).toEqual(outcome)
  })

  it('asks for drive.file again, rather than a dead button, when the connection lacks it', async () => {
    await configured()
    await aConnection(['openid', 'email'])
    const outcome = await mint()
    expect(outcome).toEqual({
      _tag: 'consent',
      href: `/api/connections/google/start?product=drive&scopes=drive.file&return=${encodeURIComponent(RETURN)}`,
    })
    expect(leaks(outcome)).toBe(false)
  })

  it('refuses a connection holding a scope that does not read the picked file, and hands no token over', async () => {
    await configured()
    await aConnection([
      'openid',
      'email',
      'drive.file',
      'drive.readonly',
      'calendar.events.readonly',
    ])
    const exit = await Effect.runPromiseExit(
      mintPickerTokenProgram(FIXTURE_ACTOR.id, 'google', LIVE),
    )
    if (Exit.isSuccess(exit)) throw new Error('the mint answered')
    expect(JSON.stringify(exit.cause)).not.toContain(TOKEN)
    await expect(mint()).rejects.toBeInstanceOf(PickerScopeTooBroad)
    await expect(mint()).rejects.toMatchObject({
      scopes: ['calendar.events.readonly'],
      message:
        'The picker opens only on a Drive connection whose scopes read the files you pick; this one also holds calendar.events.readonly. Paste a link instead.',
    })
    await expect(readiness()).rejects.toBeInstanceOf(PickerScopeTooBroad)
  })

  it('opens on a connection a folder binding grew to drive.readonly', async () => {
    await configured()
    await aConnection(['openid', 'email', 'drive.file', 'drive.readonly'])
    expect(await readiness()).toEqual({ _tag: 'ready' })
    const outcome = await mint()
    expect(outcome).toMatchObject({ _tag: 'ok', token: TOKEN })
  })

  it('mints the token with the row’s key and app id for a connection holding the picker set', async () => {
    await configured()
    await aConnection(['openid', 'email', 'drive.file'])
    const outcome = await mint()
    expect(outcome).toEqual({
      _tag: 'ok',
      token: TOKEN,
      developerKey: 'AIza-picker',
      appId: '123456789012',
      scriptUrl: 'https://apis.google.com/js/api.js',
      views: ['DOCS', 'SHARED_DRIVES'],
    })
    expect(leaks(outcome)).toBe(false)
    expect(await readiness()).toEqual({ _tag: 'ready' })
  })

  it('says the picker is not set up, naming the row an admin fixes, before asking for anything', async () => {
    expect(await mint()).toMatchObject({
      _tag: 'unconfigured',
      integrationId: null,
    })
    const id = await aDriveRow()
    const outcome = await mint()
    expect(outcome).toMatchObject({ _tag: 'unconfigured', integrationId: id })
    if (outcome._tag !== 'unconfigured') throw new Error(outcome._tag)
    expect(outcome.reason).toContain('Picker API key and Picker app id')
  })

  it('says the provider’s reason when the only connection is in error', async () => {
    await configured()
    await aConnection(['openid', 'email', 'drive.file'], {
      status: 'error',
      errorReason: 'invalid_grant: Token has been expired or revoked.',
    })
    const outcome = await mint()
    expect(outcome).toEqual({
      _tag: 'refused',
      reason: 'invalid_grant: Token has been expired or revoked.',
    })
    expect(leaks(outcome)).toBe(false)
  })

  it('lists the fake Drive’s files, with their paths and no token, under the fake providers', async () => {
    await aConnection(['openid', 'email', 'drive.file'])
    const outcome = await mint({ returnTo: RETURN, fake: true })
    if (outcome._tag !== 'fake') throw new Error(outcome._tag)
    // The account the list is titled with: the user's own connection.
    expect(outcome.account).toMatch(/@fund\.example$/)
    expect(outcome.files).toContainEqual({
      id: 'deck',
      name: 'Acme deck.pdf',
      path: 'My Drive / Acme Data Room',
    })
    expect(outcome.files).toContainEqual({
      id: 'sd-update',
      name: 'Q3 update.pdf',
      path: 'Portfolio / Acme',
    })
    expect(outcome.files.map((f) => f.id)).not.toContain('dataroom')
    expect(leaks(outcome)).toBe(false)
    expect(await readiness({ returnTo: RETURN, fake: true })).toEqual({
      _tag: 'ready',
    })
  })

  it('lists the fake Drive’s folders, roots included, for Link a Drive folder', async () => {
    await aConnection(['openid', 'email', 'drive.file'])
    const outcome = await Effect.runPromise(
      mintPickerTokenProgram(
        FIXTURE_ACTOR.id,
        'google',
        { returnTo: RETURN, fake: true },
        'folders',
      ),
    )
    if (outcome._tag !== 'fake') throw new Error(outcome._tag)
    expect(outcome.files).toContainEqual({
      id: 'root',
      name: 'My Drive',
      path: null,
    })
    expect(outcome.files).toContainEqual({
      id: 'dataroom',
      name: 'Acme Data Room',
      path: 'My Drive',
    })
    expect(outcome.files.map((f) => f.id)).not.toContain('deck')
  })
})
