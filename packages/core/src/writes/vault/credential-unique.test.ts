import { readFileSync } from 'node:fs'
import path from 'node:path'
import { TransactionRollbackError, asc, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { MIGRATIONS_FOLDER } from '@spaces/db/migrate'
import { aiRun, credential, integration, mailbox } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { encryptSecret } from './crypto'
import { resolveCredential, resolveSecret, storeCredential } from './index'

/**
 * `credential_user_unique` is NULLS NOT DISTINCT on (scope, provider, kind,
 * user_id): one workspace row per provider and kind is the database's rule,
 * not the write path's, and `storeCredential` is one upsert on it for both
 * scopes.
 */

const workspaceKey = (provider: string, secret: string) =>
  ({
    scope: 'workspace',
    provider,
    kind: 'llm',
    secret,
    createdBy: FIXTURE_ACTOR.id,
  }) as const

function rawWorkspaceRow(provider: string, secret: string, createdAt?: Date) {
  return {
    scope: 'workspace' as const,
    userId: null,
    provider,
    kind: 'llm' as const,
    secretEnc: encryptSecret(secret, `workspace:${provider}`),
    createdBy: FIXTURE_ACTOR.id,
    ...(createdAt ? { createdAt } : {}),
  }
}

async function rowsFor(provider: string) {
  return db
    .select({ id: credential.id, userId: credential.userId })
    .from(credential)
    .where(eq(credential.provider, provider))
    .orderBy(asc(credential.createdAt))
}

/** Waits until some backend on this database is blocked on a lock. */
async function untilALockWaiter(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const waiting = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`)
    if ((waiting.rows.at(0)?.n ?? 0) > 0) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('migration 0060: duplicate credentials collapse', () => {
  const MIGRATION = path.join(
    MIGRATIONS_FOLDER,
    '0060_credential_unique_nulls.sql',
  )

  it('keeps the newest row per group and repoints mailbox, integration and ai_run at it', async () => {
    // The test database is already migrated, so the old index is put back
    // inside a transaction, duplicates written under it, the migration run
    // again, and everything rolled back — the schema is never left changed.
    const outcome = db.transaction(async (tx) => {
      await tx.execute(
        sql`alter table credential drop constraint credential_user_unique`,
      )
      await tx.execute(
        sql`create unique index credential_user_unique on credential (scope, provider, user_id)`,
      )

      const [older, newer, other] = await tx
        .insert(credential)
        .values([
          rawWorkspaceRow('openai', 'sk-older', new Date('2026-01-01')),
          rawWorkspaceRow('openai', 'sk-newer', new Date('2026-02-01')),
          rawWorkspaceRow('anthropic', 'sk-only', new Date('2026-01-01')),
        ])
        .returning({ id: credential.id })

      const [plugin] = await tx
        .insert(integration)
        .values({
          capabilityId: 'test.plugin',
          version: '1.0.0',
          credentialId: older.id,
        })
        .returning({ id: integration.id })
      const [box] = await tx
        .insert(mailbox)
        .values({
          integrationId: plugin.id,
          address: 'deals@fund.example',
          host: 'imap.fund.example',
          credentialId: older.id,
        })
        .returning({ id: mailbox.id })
      const [run] = await tx
        .insert(aiRun)
        .values({
          task: 'Read deck',
          startedByType: 'system',
          credentialId: older.id,
        })
        .returning({ id: aiRun.id })

      const statements = readFileSync(MIGRATION, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      for (const statement of statements) await tx.execute(sql.raw(statement))

      const left = await tx
        .select({ id: credential.id, provider: credential.provider })
        .from(credential)
        .orderBy(asc(credential.provider))
      expect(left).toEqual([
        { id: other.id, provider: 'anthropic' },
        { id: newer.id, provider: 'openai' },
      ])

      // One connection inside a transaction, so the reads run in turn.
      const pointers = [
        await tx
          .select({ to: integration.credentialId })
          .from(integration)
          .where(eq(integration.id, plugin.id)),
        await tx
          .select({ to: mailbox.credentialId })
          .from(mailbox)
          .where(eq(mailbox.id, box.id)),
        await tx
          .select({ to: aiRun.credentialId })
          .from(aiRun)
          .where(eq(aiRun.id, run.id)),
      ]
      expect(pointers.map((rows) => rows.at(0)?.to)).toEqual([
        newer.id,
        newer.id,
        newer.id,
      ])

      const constraint = await tx.execute<{ def: string }>(sql`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'credential_user_unique'`)
      expect(constraint.rows.at(0)?.def).toBe(
        'UNIQUE NULLS NOT DISTINCT (scope, provider, user_id)',
      )

      tx.rollback()
    })
    await expect(outcome).rejects.toBeInstanceOf(TransactionRollbackError)
  })
})

describe('one workspace credential per provider and kind', () => {
  it('is the constraint the database holds', async () => {
    const constraint = await db.execute<{ def: string }>(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'credential_user_unique'`)
    expect(constraint.rows.at(0)?.def).toBe(
      'UNIQUE NULLS NOT DISTINCT (scope, provider, kind, user_id)',
    )
  })

  it('keeps a Gemini llm key and a Google oauth_client apart on provider google', async () => {
    const gemini = await storeCredential({
      ...workspaceKey('google', 'AIza-gemini-key-0001'),
      meta: { display: 'AIza…0001' },
    })
    const client = await storeCredential({
      scope: 'workspace',
      provider: 'google',
      kind: 'oauth_client',
      secret: 'GOCSPX-client-secret-0002',
      meta: { clientId: '48213.apps.googleusercontent.com' },
      createdBy: FIXTURE_ACTOR.id,
    })

    expect(client.id).not.toBe(gemini.id)
    expect(await rowsFor('google')).toHaveLength(2)
    await expect(resolveCredential('google', 'llm')).resolves.toEqual({
      id: gemini.id,
      scope: 'workspace',
      secret: 'AIza-gemini-key-0001',
      meta: { display: 'AIza…0001' },
    })
    await expect(resolveCredential('google', 'oauth_client')).resolves.toEqual({
      id: client.id,
      scope: 'workspace',
      secret: 'GOCSPX-client-secret-0002',
      meta: { clientId: '48213.apps.googleusercontent.com' },
    })

    // Saving the client again replaces the client, and only the client.
    await storeCredential({
      scope: 'workspace',
      provider: 'google',
      kind: 'oauth_client',
      secret: 'GOCSPX-client-secret-0003',
      meta: { clientId: '48213.apps.googleusercontent.com' },
      createdBy: FIXTURE_ACTOR.id,
    })
    expect(await rowsFor('google')).toHaveLength(2)
    await expect(resolveSecret('google', 'llm')).resolves.toBe(
      'AIza-gemini-key-0001',
    )
    await expect(resolveSecret('google', 'oauth_client')).resolves.toBe(
      'GOCSPX-client-secret-0003',
    )
  })

  it('refuses a second workspace row for a provider and kind', async () => {
    await db.insert(credential).values(rawWorkspaceRow('openai', 'sk-one'))
    await expect(
      db.insert(credential).values(rawWorkspaceRow('openai', 'sk-two')),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'credential_user_unique' },
    })
  })

  it('two first-time saves at once leave one row holding the later key', async () => {
    // The first save's insert is in flight, uncommitted, when the second
    // arrives: the second must wait on the constraint, then update that row.
    let second: ReturnType<typeof storeCredential> | undefined
    await db.transaction(async (tx) => {
      await tx
        .insert(credential)
        .values(rawWorkspaceRow('race', 'sk-first-save-0001'))
      second = storeCredential(workspaceKey('race', 'sk-second-save-0002'))
      second.catch(() => {})
      await untilALockWaiter()
    })
    await second

    expect(await rowsFor('race')).toHaveLength(1)
    await expect(resolveSecret('race', 'llm')).resolves.toBe(
      'sk-second-save-0002',
    )
  })

  it('a burst of concurrent saves leaves exactly one row', async () => {
    const secrets = Array.from({ length: 8 }, (_, i) => `sk-burst-key-000${i}`)
    const saved = await Promise.all(
      secrets.map((s) => storeCredential(workspaceKey('burst', s))),
    )

    const rows = await rowsFor('burst')
    expect(rows).toHaveLength(1)
    expect(new Set(saved.map((s) => s.id))).toEqual(new Set([rows[0].id]))
    expect(secrets).toContain(await resolveSecret('burst', 'llm'))
  })
})

describe('user-scoped credentials', () => {
  it('keep one row per (scope, provider, kind, user), upserted on save', async () => {
    const other = {
      id: 'vault-second-user',
      name: 'Second User',
      email: 'second@spaces.test',
    }
    await db.insert(user).values(other)
    const mine = {
      scope: 'user',
      provider: 'openai',
      kind: 'llm',
      createdBy: FIXTURE_ACTOR.id,
    } as const

    const first = await storeCredential({
      ...mine,
      userId: FIXTURE_ACTOR.id,
      secret: 'sk-mine-first-0001',
    })
    const again = await storeCredential({
      ...mine,
      userId: FIXTURE_ACTOR.id,
      secret: 'sk-mine-again-0002',
    })
    await storeCredential({
      ...mine,
      userId: other.id,
      createdBy: other.id,
      secret: 'sk-theirs-00000003',
    })
    await storeCredential(workspaceKey('openai', 'sk-workspace-00004'))

    expect(again.id).toBe(first.id)
    const rows = await db
      .select({ scope: credential.scope, userId: credential.userId })
      .from(credential)
      .where(eq(credential.provider, 'openai'))
    expect(rows).toHaveLength(3)
    await expect(
      resolveSecret('openai', 'llm', FIXTURE_ACTOR.id),
    ).resolves.toBe('sk-mine-again-0002')
    await expect(resolveSecret('openai', 'llm', other.id)).resolves.toBe(
      'sk-theirs-00000003',
    )
    await expect(resolveSecret('openai', 'llm')).resolves.toBe(
      'sk-workspace-00004',
    )
  })
})
