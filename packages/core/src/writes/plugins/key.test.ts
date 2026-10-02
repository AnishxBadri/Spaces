import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { credential, integration } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveSecretById } from '../vault/index'
import { keyIntegration } from './key'

const key = (secret: string) =>
  Effect.runPromise(
    keyIntegration({
      capabilityId: 'apollo',
      version: '0.1.0',
      kind: 'enrichment',
      secret,
      createdBy: FIXTURE_ACTOR.id,
    }),
  )

const rows = () =>
  db.select().from(integration).where(eq(integration.capabilityId, 'apollo'))

describe('keyIntegration', () => {
  it('stores the key encrypted and leaves one enabled row pointing at it', async () => {
    const first = await key('first-key-0000000000')
    expect(first.created).toBe(true)

    const [row] = await rows()
    expect(row).toMatchObject({
      id: first.integrationId,
      enabled: true,
      credentialId: first.credentialId,
      version: '0.1.0',
    })
    const [cred] = await db
      .select()
      .from(credential)
      .where(eq(credential.id, first.credentialId))
    expect(cred).toMatchObject({
      scope: 'workspace',
      provider: 'apollo',
      kind: 'enrichment',
      userId: null,
    })
    expect(cred.secretEnc.toString('utf8')).not.toContain(
      'first-key-0000000000',
    )
    expect(await resolveSecretById(first.credentialId)).toBe(
      'first-key-0000000000',
    )
  })

  it('updates the key and the row on a second run, adding neither', async () => {
    const first = await key('first-key-0000000000')
    const second = await key('second-key-000000000')
    expect(second).toMatchObject({
      created: false,
      integrationId: first.integrationId,
      credentialId: first.credentialId,
    })
    expect(await rows()).toHaveLength(1)
    expect(
      await db
        .select({ id: credential.id })
        .from(credential)
        .where(eq(credential.provider, 'apollo')),
    ).toHaveLength(1)
    expect(await resolveSecretById(first.credentialId)).toBe(
      'second-key-000000000',
    )
  })

  it('re-enables a row an operator switched off', async () => {
    const first = await key('first-key-0000000000')
    await db
      .update(integration)
      .set({ enabled: false })
      .where(eq(integration.id, first.integrationId))
    await key('first-key-0000000000')
    expect((await rows()).map((r) => r.enabled)).toEqual([true])
  })
})
