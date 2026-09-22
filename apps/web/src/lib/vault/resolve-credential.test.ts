import { count, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { credential } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import {
  mergeCredentialMeta,
  resolveCredential,
  resolveSecret,
  storeCredential,
} from './index'

/**
 * SPA-29. `resolveSecret` returned the decrypted string and nothing else, so
 * a credential's `meta` — the base URL and headers a gateway passthrough
 * needs — was unreachable through the vault's read path. `resolveCredential`
 * returns both; `resolveSecret` is now that minus the meta.
 */

const base = {
  scope: 'workspace',
  kind: 'llm',
  createdBy: FIXTURE_ACTOR.id,
} as const

describe('resolveCredential', () => {
  it('returns the secret with the row meta', async () => {
    const meta = {
      baseUrl: 'https://gateway.fund.example/v1',
      headers: { 'Helicone-Auth': 'Bearer hc-1' },
    }
    await storeCredential({
      ...base,
      provider: 'meta-reader',
      secret: 'sk-meta-reader-0001',
      meta,
    })

    const resolved = await resolveCredential('meta-reader')
    expect(resolved).toMatchObject({
      scope: 'workspace',
      secret: 'sk-meta-reader-0001',
      meta,
    })
    await expect(resolveSecret('meta-reader')).resolves.toBe(
      'sk-meta-reader-0001',
    )
    await expect(resolveCredential('nobody-saved-this')).resolves.toBeNull()
  })

  it('merges meta keys without touching the ciphertext', async () => {
    const { id } = await storeCredential({
      ...base,
      provider: 'meta-merge',
      secret: 'sk-meta-merge-0001',
      meta: { baseUrl: 'https://a.example/v1', display: 'sk-…0001' },
    })
    await mergeCredentialMeta(id, { lastTestOk: false, baseUrl: null })

    const resolved = await resolveCredential('meta-merge')
    expect(resolved?.secret).toBe('sk-meta-merge-0001')
    expect(resolved?.meta).toEqual({
      baseUrl: null,
      display: 'sk-…0001',
      lastTestOk: false,
    })
  })
})

describe('a workspace key saved twice', () => {
  it('replaces the one row instead of adding a second', async () => {
    // `credential_user_unique` is (scope, provider, user_id) and a workspace
    // row's user_id is null, which Postgres counts as distinct — so an upsert
    // on that index never fired and the second save used to insert.
    await storeCredential({
      ...base,
      provider: 'twice',
      secret: 'sk-first-key-0001',
    })
    await storeCredential({
      ...base,
      provider: 'twice',
      secret: 'sk-second-key-0002',
      meta: { baseUrl: 'https://b.example/v1' },
    })

    const [{ value }] = await db
      .select({ value: count() })
      .from(credential)
      .where(eq(credential.provider, 'twice'))
    expect(value).toBe(1)
    await expect(resolveCredential('twice')).resolves.toMatchObject({
      secret: 'sk-second-key-0002',
      meta: { baseUrl: 'https://b.example/v1' },
    })
  })
})
