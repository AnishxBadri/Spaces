import { count, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { credential } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { encryptSecret } from './crypto'
import { CREDENTIAL_KINDS, resolveSecret, storeCredential } from './index'
import type { CredentialInput } from './index'

/**
 * SPA-112. `credential_kind` opened from `llm | enrichment | search` to six
 * values so `storage-1` (OAuth client id/secret), `sdk-23` (webhook signing
 * secrets) and the AI substrate's embedding providers have a column that can
 * hold what they were specified against.
 *
 * Two things have to stay true across that widening: every row written under
 * the old enum still decrypts (the AAD is `scope:provider`, so `kind` was
 * never an encryption input), and a kind outside the six is refused at the
 * vault's Zod boundary rather than by Postgres.
 */

const base = {
  scope: 'workspace',
  provider: 'anthropic',
  secret: 'sk-ant-0123456789abcdef',
  createdBy: FIXTURE_ACTOR.id,
} as const

describe('a row written before the enum widened', () => {
  it('keeps its kind and still decrypts', async () => {
    // Written the way the pre-SPA-112 code path wrote it: one of the three
    // original kinds, ciphertext bound to `scope:provider` and to nothing
    // else. The bytes are what that path produced — the secret, the AAD and
    // the master key are its only inputs.
    const secret = 'sk-ant-written-before-the-migration'
    await db.insert(credential).values({
      scope: 'workspace',
      provider: 'anthropic',
      kind: 'llm',
      secretEnc: encryptSecret(secret, 'workspace:anthropic'),
      createdBy: FIXTURE_ACTOR.id,
    })

    const row = (
      await db
        .select({ kind: credential.kind })
        .from(credential)
        .where(eq(credential.provider, 'anthropic'))
    ).at(0)
    expect(row?.kind).toBe('llm')
    await expect(resolveSecret('anthropic')).resolves.toBe(secret)

    // And moving that row onto a value the enum only just gained changes
    // nothing about the ciphertext, which is the whole argument for why the
    // widening needs no re-encryption pass.
    await db
      .update(credential)
      .set({ kind: 'embedding' })
      .where(eq(credential.provider, 'anthropic'))
    await expect(resolveSecret('anthropic')).resolves.toBe(secret)
  })
})

describe('the vault write path', () => {
  it('accepts all six kinds', async () => {
    expect(CREDENTIAL_KINDS).toEqual([
      'llm',
      'embedding',
      'enrichment',
      'search',
      'oauth_client',
      'webhook',
    ])

    for (const kind of CREDENTIAL_KINDS) {
      const secret = `secret-for-${kind}`
      const { display } = await storeCredential({
        ...base,
        provider: `provider-${kind}`,
        kind,
        secret,
      })
      expect(display).not.toContain(secret.slice(4, -4))
      await expect(resolveSecret(`provider-${kind}`)).resolves.toBe(secret)
    }

    const stored = await db
      .select({ kind: credential.kind })
      .from(credential)
      .where(
        inArray(
          credential.provider,
          CREDENTIAL_KINDS.map((kind) => `provider-${kind}`),
        ),
      )
    expect(stored.map((r) => r.kind).sort()).toEqual(
      [...CREDENTIAL_KINDS].sort(),
    )
  })

  it('rejects an unknown kind at the Zod boundary, not at the database', async () => {
    // What actually reaches a server fn is untyped, so the rogue value is
    // laundered through JSON exactly as the wire would deliver it — the
    // compiler cannot be the thing that catches this, which is why the
    // boundary exists.
    const fromTheWire: CredentialInput = JSON.parse(
      JSON.stringify({ ...base, provider: 'rogue', kind: 'oauth' }),
    )

    await expect(storeCredential(fromTheWire)).rejects.toBeInstanceOf(
      z.ZodError,
    )

    const [{ value }] = await db
      .select({ value: count() })
      .from(credential)
      .where(eq(credential.provider, 'rogue'))
    expect(value).toBe(0)
  })
})
